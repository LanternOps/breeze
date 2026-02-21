/**
 * AI MCP Tool Definitions
 *
 * Each tool wraps existing Breeze services with org-scoped data isolation.
 * Tools are defined as Anthropic API tool definitions + handler functions.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { isIP } from 'node:net';
import { db } from '../db';
import {
  devices,
  deviceHardware,
  deviceNetwork,
  deviceDisks,
  deviceMetrics,
  deviceBootMetrics,
  deviceIpHistory,
  alerts,
  networkBaselines,
  networkChangeEvents,
  sites,
  organizations,
  auditLogs,
  deviceCommands,
  deviceFilesystemCleanupRuns,
  deviceSessions,
  playbookDefinitions,
  playbookExecutions,
  softwareComplianceStatus,
  softwarePolicies,
  deviceChangeLog,
  dnsFilterIntegrations,
  dnsEventAggregations,
  dnsPolicies,
  dnsSecurityEvents,
  dnsThreatCategoryEnum,
  type DnsPolicyDomain
} from '../db/schema';
import { eq, and, desc, sql, like, inArray, gte, lte, SQL } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';
import { escapeLike } from '../utils/sql';
import { validateToolInput } from './aiToolSchemas';
import { schedulePolicySync } from '../jobs/dnsSyncJob';
import { registerAgentLogTools } from './aiToolsAgentLogs';
import { registerConfigPolicyTools } from './aiToolsConfigPolicy';
import { registerEventLogTools } from './aiToolsEventLogs';
import { registerFleetTools } from './aiToolsFleet';
import { scheduleSoftwareComplianceCheck } from '../jobs/softwareComplianceWorker';
import { scheduleSoftwareRemediation } from '../jobs/softwareRemediationWorker';
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
import {
  normalizeBaselineAlertSettings,
  normalizeBaselineScanSchedule
} from './networkBaseline';
import { checkPlaybookRequiredPermissions } from './playbookPermissions';
import { normalizeSoftwarePolicyRules } from './softwarePolicyService';
import { listReliabilityDevices } from './reliabilityScoring';
import {
  mergeBootRecords,
  parseCollectorBootMetricsFromCommandResult,
} from './bootPerformance';
import {
  normalizeStartupItems,
  resolveStartupItem,
} from './startupItems';

type AiToolTier = 1 | 2 | 3 | 4;

function normalizeIpLiteral(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const withoutZone = trimmed.includes('%')
    ? trimmed.slice(0, Math.max(trimmed.indexOf('%'), 0))
    : trimmed;

  const parsed = isIP(withoutZone);
  if (parsed === 0) return null;
  return parsed === 6 ? withoutZone.toLowerCase() : withoutZone;
}

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

function normalizeDnsDomain(domain: unknown): string | null {
  if (typeof domain !== 'string') return null;
  const normalized = domain.trim().toLowerCase().replace(/\.$/, '');
  if (!normalized || normalized.length > 500) return null;
  return normalized;
}

function normalizeDnsCategory(category: unknown): string | null {
  if (typeof category !== 'string' || !category.trim()) return null;
  const normalized = category.trim().toLowerCase().replace(/\s+/g, '_').replace(/-/g, '_');
  if (dnsThreatCategoryEnum.enumValues.includes(normalized as typeof dnsThreatCategoryEnum.enumValues[number])) {
    return normalized;
  }
  if (normalized.includes('phish')) return 'phishing';
  if (normalized.includes('malware')) return 'malware';
  if (normalized.includes('bot')) return 'botnet';
  if (normalized.includes('ransom')) return 'ransomware';
  if (normalized.includes('crypto')) return 'cryptomining';
  if (normalized.includes('spam')) return 'spam';
  if (normalized.includes('adult')) return 'adult_content';
  if (normalized.includes('ad')) return 'adware';
  if (normalized.includes('gambl')) return 'gambling';
  if (normalized.includes('social')) return 'social_media';
  if (normalized.includes('stream')) return 'streaming';
  return 'unknown';
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
// get_network_changes - Tier 1 (read-only)
// ============================================

registerTool({
  tier: 1,
  definition: {
    name: 'get_network_changes',
    description: 'Query network change events (new devices, disappeared devices, changed devices, and rogue devices).',
    input_schema: {
      type: 'object' as const,
      properties: {
        org_id: { type: 'string', description: 'Optional organization UUID filter' },
        site_id: { type: 'string', description: 'Optional site UUID filter' },
        baseline_id: { type: 'string', description: 'Optional baseline UUID filter' },
        event_type: {
          type: 'string',
          enum: ['new_device', 'device_disappeared', 'device_changed', 'rogue_device'],
          description: 'Filter by event type'
        },
        acknowledged: { type: 'boolean', description: 'Filter by acknowledgment status' },
        since: { type: 'string', description: 'Only include changes detected after this ISO timestamp' },
        limit: { type: 'number', description: 'Max results (default: 50, max: 200)' }
      }
    }
  },
  handler: async (input, auth) => {
    const orgId = typeof input.org_id === 'string' ? input.org_id : undefined;
    if (orgId && !auth.canAccessOrg(orgId)) {
      return JSON.stringify({ error: 'Access to this organization denied' });
    }

    const conditions: SQL[] = [];
    const orgCondition = auth.orgCondition(networkChangeEvents.orgId);
    if (orgCondition) conditions.push(orgCondition);

    if (orgId) conditions.push(eq(networkChangeEvents.orgId, orgId));

    const siteId = typeof input.site_id === 'string' ? input.site_id : undefined;
    if (siteId) conditions.push(eq(networkChangeEvents.siteId, siteId));

    const baselineId = typeof input.baseline_id === 'string' ? input.baseline_id : undefined;
    if (baselineId) conditions.push(eq(networkChangeEvents.baselineId, baselineId));

    const eventType = typeof input.event_type === 'string'
      ? input.event_type as typeof networkChangeEvents.eventType.enumValues[number]
      : undefined;
    if (eventType) conditions.push(eq(networkChangeEvents.eventType, eventType));

    if (typeof input.acknowledged === 'boolean') {
      conditions.push(eq(networkChangeEvents.acknowledged, input.acknowledged));
    }

    const since = typeof input.since === 'string' ? new Date(input.since) : null;
    if (since && !Number.isNaN(since.getTime())) {
      conditions.push(gte(networkChangeEvents.detectedAt, since));
    }

    const limit = Math.min(Math.max(1, Number(input.limit) || 50), 200);

    const events = await db
      .select()
      .from(networkChangeEvents)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(networkChangeEvents.detectedAt))
      .limit(limit);

    return JSON.stringify({
      events,
      count: events.length
    });
  }
});

// ============================================
// acknowledge_network_device - Tier 2 (mutating)
// ============================================

registerTool({
  tier: 2,
  definition: {
    name: 'acknowledge_network_device',
    description: 'Acknowledge a network change event and optionally attach notes.',
    input_schema: {
      type: 'object' as const,
      properties: {
        event_id: { type: 'string', description: 'Network change event UUID' },
        notes: { type: 'string', description: 'Optional acknowledgment notes' }
      },
      required: ['event_id']
    }
  },
  handler: async (input, auth) => {
    const eventId = input.event_id as string;
    const notes = typeof input.notes === 'string' ? input.notes : undefined;

    const conditions: SQL[] = [eq(networkChangeEvents.id, eventId)];
    const orgCondition = auth.orgCondition(networkChangeEvents.orgId);
    if (orgCondition) conditions.push(orgCondition);

    const [event] = await db
      .select()
      .from(networkChangeEvents)
      .where(and(...conditions))
      .limit(1);

    if (!event) {
      return JSON.stringify({ error: 'Event not found or access denied' });
    }

    if (event.acknowledged) {
      return JSON.stringify({ error: 'Event already acknowledged' });
    }

    await db
      .update(networkChangeEvents)
      .set({
        acknowledged: true,
        acknowledgedBy: auth.user.id,
        acknowledgedAt: new Date(),
        notes: notes ?? event.notes
      })
      .where(eq(networkChangeEvents.id, event.id));

    return JSON.stringify({ success: true, eventId: event.id });
  }
});

// ============================================
// configure_network_baseline - Tier 2 (mutating)
// ============================================

registerTool({
  tier: 2,
  definition: {
    name: 'configure_network_baseline',
    description: 'Create or update network baseline configuration for scheduled scan cadence and alert behavior.',
    input_schema: {
      type: 'object' as const,
      properties: {
        baseline_id: { type: 'string', description: 'Existing baseline UUID to update' },
        org_id: { type: 'string', description: 'Organization UUID (required for creation)' },
        site_id: { type: 'string', description: 'Site UUID (required for creation)' },
        subnet: { type: 'string', description: 'CIDR subnet, e.g. 192.168.1.0/24' },
        scan_interval_hours: { type: 'number', description: 'Scan interval in hours (default 4)' },
        alert_on_new_device: { type: 'boolean', description: 'Enable alerts for new devices' },
        alert_on_disappeared: { type: 'boolean', description: 'Enable alerts for disappeared devices' },
        alert_on_changed: { type: 'boolean', description: 'Enable alerts for changed devices' },
        alert_on_rogue_device: { type: 'boolean', description: 'Enable alerts for rogue devices' }
      }
    }
  },
  handler: async (input, auth) => {
    const baselineId = typeof input.baseline_id === 'string' ? input.baseline_id : undefined;

    const intervalInput = Number(input.scan_interval_hours);
    const hasIntervalInput = Number.isFinite(intervalInput) && intervalInput > 0;

    const alertOverrides = {
      newDevice: typeof input.alert_on_new_device === 'boolean' ? input.alert_on_new_device : undefined,
      disappeared: typeof input.alert_on_disappeared === 'boolean' ? input.alert_on_disappeared : undefined,
      changed: typeof input.alert_on_changed === 'boolean' ? input.alert_on_changed : undefined,
      rogueDevice: typeof input.alert_on_rogue_device === 'boolean' ? input.alert_on_rogue_device : undefined
    };

    if (baselineId) {
      const conditions: SQL[] = [eq(networkBaselines.id, baselineId)];
      const orgCondition = auth.orgCondition(networkBaselines.orgId);
      if (orgCondition) conditions.push(orgCondition);

      const [baseline] = await db
        .select()
        .from(networkBaselines)
        .where(and(...conditions))
        .limit(1);

      if (!baseline) {
        return JSON.stringify({ error: 'Baseline not found or access denied' });
      }

      const currentSchedule = normalizeBaselineScanSchedule(baseline.scanSchedule);
      const currentAlertSettings = normalizeBaselineAlertSettings(baseline.alertSettings);

      const schedulePatch: Record<string, unknown> = { ...currentSchedule };
      if (hasIntervalInput) {
        schedulePatch.intervalHours = Math.trunc(intervalInput);
      }

      const nextSchedule = normalizeBaselineScanSchedule(schedulePatch, currentSchedule.intervalHours);
      const nextAlertSettings = normalizeBaselineAlertSettings({
        ...currentAlertSettings,
        ...(alertOverrides.newDevice !== undefined ? { newDevice: alertOverrides.newDevice } : {}),
        ...(alertOverrides.disappeared !== undefined ? { disappeared: alertOverrides.disappeared } : {}),
        ...(alertOverrides.changed !== undefined ? { changed: alertOverrides.changed } : {}),
        ...(alertOverrides.rogueDevice !== undefined ? { rogueDevice: alertOverrides.rogueDevice } : {})
      });

      await db
        .update(networkBaselines)
        .set({
          scanSchedule: nextSchedule,
          alertSettings: nextAlertSettings,
          updatedAt: new Date()
        })
        .where(eq(networkBaselines.id, baseline.id));

      return JSON.stringify({ success: true, baselineId: baseline.id, action: 'updated' });
    }

    const orgId = typeof input.org_id === 'string' ? input.org_id : undefined;
    const siteId = typeof input.site_id === 'string' ? input.site_id : undefined;
    const subnet = typeof input.subnet === 'string' ? input.subnet : undefined;

    if (!orgId || !siteId || !subnet) {
      return JSON.stringify({ error: 'org_id, site_id, and subnet are required when creating a baseline' });
    }

    if (!auth.canAccessOrg(orgId)) {
      return JSON.stringify({ error: 'Access to this organization denied' });
    }

    const [site] = await db
      .select({ id: sites.id })
      .from(sites)
      .where(and(eq(sites.id, siteId), eq(sites.orgId, orgId)))
      .limit(1);

    if (!site) {
      return JSON.stringify({ error: 'Site not found for this organization' });
    }

    const nextSchedule = normalizeBaselineScanSchedule({
      enabled: true,
      intervalHours: hasIntervalInput ? Math.trunc(intervalInput) : undefined
    });
    const nextAlertSettings = normalizeBaselineAlertSettings({
      ...(alertOverrides.newDevice !== undefined ? { newDevice: alertOverrides.newDevice } : {}),
      ...(alertOverrides.disappeared !== undefined ? { disappeared: alertOverrides.disappeared } : {}),
      ...(alertOverrides.changed !== undefined ? { changed: alertOverrides.changed } : {}),
      ...(alertOverrides.rogueDevice !== undefined ? { rogueDevice: alertOverrides.rogueDevice } : {})
    });

    try {
      const [created] = await db
        .insert(networkBaselines)
        .values({
          orgId,
          siteId,
          subnet,
          knownDevices: [],
          scanSchedule: nextSchedule,
          alertSettings: nextAlertSettings,
          updatedAt: new Date()
        })
        .returning({ id: networkBaselines.id });

      if (!created) {
        return JSON.stringify({ error: 'Failed to create baseline' });
      }

      return JSON.stringify({ success: true, baselineId: created.id, action: 'created' });
    } catch (error) {
      const pgError = error as { code?: string };
      if (pgError.code === '23505') {
        return JSON.stringify({ error: 'Baseline already exists for this org/site/subnet' });
      }
      throw error;
    }
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
// get_ip_history - Tier 1 (auto-execute)
// ============================================

registerTool({
  tier: 1,
  definition: {
    name: 'get_ip_history',
    description: 'Query historical IP assignments. Supports timeline mode (device_id) and reverse lookup mode (ip_address + at_time).',
    input_schema: {
      type: 'object' as const,
      properties: {
        device_id: { type: 'string', description: 'Device UUID for timeline mode' },
        ip_address: { type: 'string', description: 'IP address for reverse lookup mode' },
        at_time: { type: 'string', description: 'ISO timestamp used with ip_address for reverse lookup mode' },
        since: { type: 'string', description: 'Optional timeline lower bound (ISO timestamp)' },
        until: { type: 'string', description: 'Optional timeline upper bound (ISO timestamp)' },
        interface_name: { type: 'string', description: 'Optional interface name filter' },
        assignment_type: { type: 'string', enum: ['dhcp', 'static', 'vpn', 'link-local', 'unknown'], description: 'Optional assignment type filter' },
        active_only: { type: 'boolean', description: 'Only include active assignments (default false)' },
        limit: { type: 'number', description: 'Max rows to return (default 100, max 500)' },
      },
    },
  },
  handler: async (input, auth) => {
    const deviceId = typeof input.device_id === 'string' ? input.device_id : undefined;
    const rawIpAddress = typeof input.ip_address === 'string' ? input.ip_address : undefined;
    const ipAddress = rawIpAddress ? normalizeIpLiteral(rawIpAddress) : undefined;
    const atTime = typeof input.at_time === 'string' ? input.at_time : undefined;
    const since = typeof input.since === 'string' ? input.since : undefined;
    const until = typeof input.until === 'string' ? input.until : undefined;
    const interfaceName = typeof input.interface_name === 'string' ? input.interface_name : undefined;
    const assignmentType = typeof input.assignment_type === 'string' ? input.assignment_type : undefined;
    const activeOnly = input.active_only === true;
    const parsedLimit = Number(input.limit);
    const limit = Number.isFinite(parsedLimit)
      ? Math.min(Math.max(Math.trunc(parsedLimit), 1), 500)
      : 100;

    if (deviceId) {
      const access = await verifyDeviceAccess(deviceId, auth);
      if ('error' in access) return JSON.stringify({ error: access.error });

      const conditions: SQL[] = [eq(deviceIpHistory.deviceId, deviceId)];

      if (since) {
        const sinceDate = new Date(since);
        if (Number.isNaN(sinceDate.getTime())) {
          return JSON.stringify({ error: 'Invalid since timestamp' });
        }
        conditions.push(gte(deviceIpHistory.lastSeen, sinceDate));
      }

      if (until) {
        const untilDate = new Date(until);
        if (Number.isNaN(untilDate.getTime())) {
          return JSON.stringify({ error: 'Invalid until timestamp' });
        }
        conditions.push(lte(deviceIpHistory.firstSeen, untilDate));
      }

      if (interfaceName) {
        conditions.push(eq(deviceIpHistory.interfaceName, interfaceName));
      }

      if (assignmentType) {
        conditions.push(eq(deviceIpHistory.assignmentType, assignmentType as typeof deviceIpHistory.assignmentType.enumValues[number]));
      }

      if (activeOnly) {
        conditions.push(eq(deviceIpHistory.isActive, true));
      }

      const history = await db
        .select()
        .from(deviceIpHistory)
        .where(and(...conditions))
        .orderBy(desc(deviceIpHistory.firstSeen))
        .limit(limit);

      return JSON.stringify({
        mode: 'timeline',
        device_id: deviceId,
        hostname: access.device.hostname,
        history,
        count: history.length,
      });
    }

    if (ipAddress) {
      if (!atTime) {
        return JSON.stringify({
          error: 'at_time is required when ip_address is provided',
        });
      }

      const targetTime = new Date(atTime);
      if (Number.isNaN(targetTime.getTime())) {
        return JSON.stringify({ error: 'Invalid at_time timestamp' });
      }
      if (targetTime.getTime() > Date.now()) {
        return JSON.stringify({ error: 'at_time cannot be in the future' });
      }

      const conditions: SQL[] = [
        eq(deviceIpHistory.ipAddress, ipAddress),
        lte(deviceIpHistory.firstSeen, targetTime),
        gte(deviceIpHistory.lastSeen, targetTime),
      ];

      const orgCondition = auth.orgCondition(deviceIpHistory.orgId);
      if (orgCondition) {
        conditions.push(orgCondition);
      }

      if (interfaceName) {
        conditions.push(eq(deviceIpHistory.interfaceName, interfaceName));
      }

      if (assignmentType) {
        conditions.push(eq(deviceIpHistory.assignmentType, assignmentType as typeof deviceIpHistory.assignmentType.enumValues[number]));
      }

      const results = await db
        .select({
          ipHistory: deviceIpHistory,
          device: devices,
        })
        .from(deviceIpHistory)
        .innerJoin(devices, eq(deviceIpHistory.deviceId, devices.id))
        .where(and(...conditions))
        .orderBy(desc(deviceIpHistory.firstSeen))
        .limit(limit);

      return JSON.stringify({
        mode: 'reverse_lookup',
        ip_address: ipAddress,
        at_time: atTime,
        results: results.map((row) => ({
          device: {
            id: row.device.id,
            hostname: row.device.hostname,
            osType: row.device.osType,
          },
          assignment: {
            interfaceName: row.ipHistory.interfaceName,
            assignmentType: row.ipHistory.assignmentType,
            firstSeen: row.ipHistory.firstSeen,
            lastSeen: row.ipHistory.lastSeen,
            isActive: row.ipHistory.isActive,
          },
        })),
        count: results.length,
      });
    }

    if (rawIpAddress && !ipAddress) {
      return JSON.stringify({ error: 'Invalid ip_address format' });
    }

    return JSON.stringify({
      error: 'Either device_id (timeline) or ip_address + at_time (reverse lookup) must be provided',
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

      let eventWarning: string | undefined;
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
        eventWarning = 'Alert was acknowledged but event notification may be delayed';
      }

      return JSON.stringify({ success: true, message: `Alert "${alert.title}" acknowledged`, warning: eventWarning });
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

      let resolveEventWarning: string | undefined;
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
        resolveEventWarning = 'Alert was resolved but event notification may be delayed';
      }

      return JSON.stringify({ success: true, message: `Alert "${alert.title}" resolved`, warning: resolveEventWarning });
    }

    return JSON.stringify({ error: `Unknown action: ${action}` });
  }
});

// ============================================
// get_dns_security - Tier 1 (auto-execute)
// ============================================

registerTool({
  tier: 1,
  definition: {
    name: 'get_dns_security',
    description: 'Get DNS security statistics including blocked domains, threat categories, and top offending devices.',
    input_schema: {
      type: 'object' as const,
      properties: {
        timeRange: {
          type: 'object',
          properties: {
            start: { type: 'string', description: 'Start time (ISO 8601)' },
            end: { type: 'string', description: 'End time (ISO 8601)' }
          },
          required: ['start', 'end']
        },
        deviceId: { type: 'string', description: 'Filter by device ID' },
        integrationId: { type: 'string', description: 'Filter by integration ID' },
        action: { type: 'string', enum: ['allowed', 'blocked', 'redirected'], description: 'Filter by DNS action' },
        category: { type: 'string', description: 'Filter by threat category' },
        topN: { type: 'number', description: 'Number of top results to return (default 10, max 100)' }
      },
      required: ['timeRange']
    }
  },
  handler: async (input, auth) => {
    const AGGREGATION_MIN_DAYS = 7;
    const toDateKey = (value: Date): string => value.toISOString().slice(0, 10);
    const shouldUseAggregations = (startDate: Date, endDate: Date): boolean => {
      const diffMs = endDate.getTime() - startDate.getTime();
      return diffMs > AGGREGATION_MIN_DAYS * 24 * 60 * 60 * 1000;
    };

    const timeRange = (input.timeRange ?? {}) as { start?: string; end?: string };
    const start = timeRange.start ? new Date(timeRange.start) : null;
    const end = timeRange.end ? new Date(timeRange.end) : null;

    if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return JSON.stringify({ error: 'timeRange.start and timeRange.end must be valid ISO timestamps' });
    }
    if (start.getTime() > end.getTime()) {
      return JSON.stringify({ error: 'timeRange.start must be before or equal to timeRange.end' });
    }
    const maxWindowMs = 90 * 24 * 60 * 60 * 1000;
    if ((end.getTime() - start.getTime()) > maxWindowMs) {
      return JSON.stringify({ error: 'timeRange cannot exceed 90 days' });
    }

    const conditions: SQL[] = [
      gte(dnsSecurityEvents.timestamp, start),
      lte(dnsSecurityEvents.timestamp, end)
    ];
    const orgCondition = auth.orgCondition(dnsSecurityEvents.orgId);
    if (orgCondition) conditions.push(orgCondition);

    if (input.deviceId) conditions.push(eq(dnsSecurityEvents.deviceId, input.deviceId as string));
    if (input.integrationId) conditions.push(eq(dnsSecurityEvents.integrationId, input.integrationId as string));
    if (input.action) conditions.push(eq(dnsSecurityEvents.action, input.action as typeof dnsSecurityEvents.action.enumValues[number]));
    const normalizedCategory = input.category ? normalizeDnsCategory(input.category) : null;
    if (normalizedCategory) {
      conditions.push(eq(dnsSecurityEvents.category, normalizedCategory as typeof dnsSecurityEvents.category.enumValues[number]));
    }

    const topN = Math.min(Math.max(1, Number(input.topN) || 10), 100);
    const where = and(...conditions);

    if (shouldUseAggregations(start, end)) {
      const aggConditions: SQL[] = [
        gte(dnsEventAggregations.date, toDateKey(start)),
        lte(dnsEventAggregations.date, toDateKey(end))
      ];
      const aggOrgCondition = auth.orgCondition(dnsEventAggregations.orgId);
      if (aggOrgCondition) aggConditions.push(aggOrgCondition);
      if (input.deviceId) aggConditions.push(eq(dnsEventAggregations.deviceId, input.deviceId as string));
      if (input.integrationId) aggConditions.push(eq(dnsEventAggregations.integrationId, input.integrationId as string));
      if (normalizedCategory) {
        aggConditions.push(
          eq(dnsEventAggregations.category, normalizedCategory as typeof dnsEventAggregations.category.enumValues[number])
        );
      }

      const aggWhere = and(...aggConditions);
      const [aggCountRow] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(dnsEventAggregations)
        .where(aggWhere);

      if (Number(aggCountRow?.count ?? 0) > 0) {
        const topCategoryCountExpr: SQL<number> = input.action === 'blocked'
          ? sql<number>`coalesce(sum(${dnsEventAggregations.blockedQueries}), 0)::int`
          : input.action === 'allowed'
            ? sql<number>`coalesce(sum(${dnsEventAggregations.allowedQueries}), 0)::int`
            : input.action === 'redirected'
              ? sql<number>`coalesce(sum(${dnsEventAggregations.totalQueries} - ${dnsEventAggregations.blockedQueries} - ${dnsEventAggregations.allowedQueries}), 0)::int`
              : sql<number>`coalesce(sum(${dnsEventAggregations.totalQueries}), 0)::int`;

        const [rawSummary, topBlockedDomains, topCategories, topDevices] = await Promise.all([
          db
            .select({
              totalQueries: sql<number>`coalesce(sum(${dnsEventAggregations.totalQueries}), 0)::int`,
              blockedQueries: sql<number>`coalesce(sum(${dnsEventAggregations.blockedQueries}), 0)::int`,
              allowedQueries: sql<number>`coalesce(sum(${dnsEventAggregations.allowedQueries}), 0)::int`
            })
            .from(dnsEventAggregations)
            .where(aggWhere),
          input.action && input.action !== 'blocked'
            ? Promise.resolve([])
            : db
              .select({
                domain: dnsEventAggregations.domain,
                category: dnsEventAggregations.category,
                count: sql<number>`coalesce(sum(${dnsEventAggregations.blockedQueries}), 0)::int`
              })
              .from(dnsEventAggregations)
              .where(and(
                ...aggConditions,
                sql`${dnsEventAggregations.blockedQueries} > 0`,
                sql`${dnsEventAggregations.domain} is not null`
              ))
              .groupBy(dnsEventAggregations.domain, dnsEventAggregations.category)
              .orderBy(desc(sql`coalesce(sum(${dnsEventAggregations.blockedQueries}), 0)`))
              .limit(topN),
          db
            .select({
              category: dnsEventAggregations.category,
              count: topCategoryCountExpr
            })
            .from(dnsEventAggregations)
            .where(and(...aggConditions, sql`${dnsEventAggregations.category} is not null`))
            .groupBy(dnsEventAggregations.category)
            .orderBy(desc(topCategoryCountExpr))
            .limit(topN),
          input.action && input.action !== 'blocked'
            ? Promise.resolve([])
            : db
              .select({
                deviceId: dnsEventAggregations.deviceId,
                hostname: devices.hostname,
                blockedCount: sql<number>`coalesce(sum(${dnsEventAggregations.blockedQueries}), 0)::int`
              })
              .from(dnsEventAggregations)
              .leftJoin(devices, eq(dnsEventAggregations.deviceId, devices.id))
              .where(and(...aggConditions, sql`${dnsEventAggregations.blockedQueries} > 0`))
              .groupBy(dnsEventAggregations.deviceId, devices.hostname)
              .orderBy(desc(sql`coalesce(sum(${dnsEventAggregations.blockedQueries}), 0)`))
              .limit(topN)
        ]);

        const summaryBase = rawSummary[0] ?? {
          totalQueries: 0,
          blockedQueries: 0,
          allowedQueries: 0
        };
        const redirectedFromTotals = Math.max(
          0,
          summaryBase.totalQueries - summaryBase.blockedQueries - summaryBase.allowedQueries
        );

        const summaryRow = input.action === 'blocked'
          ? {
            totalQueries: summaryBase.blockedQueries,
            blockedQueries: summaryBase.blockedQueries,
            allowedQueries: 0,
            redirectedQueries: 0
          }
          : input.action === 'allowed'
            ? {
              totalQueries: summaryBase.allowedQueries,
              blockedQueries: 0,
              allowedQueries: summaryBase.allowedQueries,
              redirectedQueries: 0
            }
            : input.action === 'redirected'
              ? {
                totalQueries: redirectedFromTotals,
                blockedQueries: 0,
                allowedQueries: 0,
                redirectedQueries: redirectedFromTotals
              }
              : {
                totalQueries: summaryBase.totalQueries,
                blockedQueries: summaryBase.blockedQueries,
                allowedQueries: summaryBase.allowedQueries,
                redirectedQueries: redirectedFromTotals
              };
        const blockedRate = summaryRow.totalQueries > 0
          ? Number(((summaryRow.blockedQueries / summaryRow.totalQueries) * 100).toFixed(2))
          : 0;

        return JSON.stringify({
          summary: {
            ...summaryRow,
            blockedRate,
            timeRange: { start: start.toISOString(), end: end.toISOString() }
          },
          topBlockedDomains,
          topCategories,
          topDevices,
          source: 'aggregated'
        });
      }
    }

    const [summary, topBlockedDomains, topCategories, topDevices] = await Promise.all([
      db
        .select({
          totalQueries: sql<number>`count(*)::int`,
          blockedQueries: sql<number>`coalesce(sum(case when ${dnsSecurityEvents.action} = 'blocked' then 1 else 0 end), 0)::int`,
          allowedQueries: sql<number>`coalesce(sum(case when ${dnsSecurityEvents.action} = 'allowed' then 1 else 0 end), 0)::int`,
          redirectedQueries: sql<number>`coalesce(sum(case when ${dnsSecurityEvents.action} = 'redirected' then 1 else 0 end), 0)::int`
        })
        .from(dnsSecurityEvents)
        .where(where),
      db
        .select({
          domain: dnsSecurityEvents.domain,
          category: dnsSecurityEvents.category,
          count: sql<number>`count(*)::int`
        })
        .from(dnsSecurityEvents)
        .where(and(where, eq(dnsSecurityEvents.action, 'blocked')))
        .groupBy(dnsSecurityEvents.domain, dnsSecurityEvents.category)
        .orderBy(desc(sql`count(*)`))
        .limit(topN),
      db
        .select({
          category: dnsSecurityEvents.category,
          count: sql<number>`count(*)::int`
        })
        .from(dnsSecurityEvents)
        .where(and(where, sql`${dnsSecurityEvents.category} is not null`))
        .groupBy(dnsSecurityEvents.category)
        .orderBy(desc(sql`count(*)`))
        .limit(topN),
      db
        .select({
          deviceId: dnsSecurityEvents.deviceId,
          hostname: devices.hostname,
          blockedCount: sql<number>`count(*)::int`
        })
        .from(dnsSecurityEvents)
        .leftJoin(devices, eq(dnsSecurityEvents.deviceId, devices.id))
        .where(and(where, eq(dnsSecurityEvents.action, 'blocked')))
        .groupBy(dnsSecurityEvents.deviceId, devices.hostname)
        .orderBy(desc(sql`count(*)`))
        .limit(topN)
    ]);

    const summaryRow = summary[0] ?? {
      totalQueries: 0,
      blockedQueries: 0,
      allowedQueries: 0,
      redirectedQueries: 0
    };
    const blockedRate = summaryRow.totalQueries > 0
      ? Number(((summaryRow.blockedQueries / summaryRow.totalQueries) * 100).toFixed(2))
      : 0;

    return JSON.stringify({
      summary: {
        ...summaryRow,
        blockedRate,
        timeRange: { start: start.toISOString(), end: end.toISOString() }
      },
      topBlockedDomains,
      topCategories,
      topDevices,
      source: 'raw'
    });
  }
});

// ============================================
// manage_dns_policy - Tier 2 (confirm before execute)
// ============================================

registerTool({
  tier: 2,
  definition: {
    name: 'manage_dns_policy',
    description: 'Add or remove domains from DNS blocklist/allowlist and schedule provider synchronization.',
    input_schema: {
      type: 'object' as const,
      properties: {
        integrationId: { type: 'string', description: 'DNS integration UUID' },
        action: { type: 'string', enum: ['add_block', 'remove_block', 'add_allow', 'remove_allow'], description: 'Policy action' },
        domains: { type: 'array', items: { type: 'string' }, description: 'Domains to add or remove' },
        reason: { type: 'string', description: 'Optional reason for policy changes' }
      },
      required: ['integrationId', 'action', 'domains']
    }
  },
  handler: async (input, auth) => {
    const integrationId = input.integrationId as string;
    const action = input.action as 'add_block' | 'remove_block' | 'add_allow' | 'remove_allow';
    const domainsInput = Array.isArray(input.domains) ? input.domains : [];
    const reason = typeof input.reason === 'string' ? input.reason : undefined;

    const domains = domainsInput
      .map((domain) => normalizeDnsDomain(domain))
      .filter((domain): domain is string => domain !== null);
    const uniqueDomains = Array.from(new Set(domains));

    if (uniqueDomains.length === 0) {
      return JSON.stringify({ error: 'No valid domains were provided' });
    }

    const integrationConditions: SQL[] = [eq(dnsFilterIntegrations.id, integrationId)];
    const orgCondition = auth.orgCondition(dnsFilterIntegrations.orgId);
    if (orgCondition) integrationConditions.push(orgCondition);

    const [integration] = await db
      .select({
        id: dnsFilterIntegrations.id,
        orgId: dnsFilterIntegrations.orgId
      })
      .from(dnsFilterIntegrations)
      .where(and(...integrationConditions))
      .limit(1);

    if (!integration) {
      return JSON.stringify({ error: 'Integration not found or access denied' });
    }

    const policyType = action === 'add_block' || action === 'remove_block' ? 'blocklist' : 'allowlist';
    const policyName = policyType === 'blocklist' ? 'AI Managed Blocklist' : 'AI Managed Allowlist';
    const isAddAction = action === 'add_block' || action === 'add_allow';
    const isRemoveAction = action === 'remove_block' || action === 'remove_allow';

    const policyConditions: SQL[] = [
      eq(dnsPolicies.integrationId, integration.id),
      eq(dnsPolicies.type, policyType),
    ];
    const policyOrgCondition = auth.orgCondition(dnsPolicies.orgId);
    if (policyOrgCondition) policyConditions.push(policyOrgCondition);

    let [policy] = await db
      .select()
      .from(dnsPolicies)
      .where(and(...policyConditions))
      .orderBy(desc(dnsPolicies.createdAt))
      .limit(1);

    if (!policy && isRemoveAction) {
      return JSON.stringify({
        success: true,
        policyId: null,
        integrationId: integration.id,
        action,
        requested: uniqueDomains.length,
        added: 0,
        removed: 0,
        syncScheduled: false,
        warning: 'No policy exists for the requested remove action'
      });
    }

    if (!policy && isAddAction) {
      const [created] = await db
        .insert(dnsPolicies)
        .values({
          orgId: integration.orgId,
          integrationId: integration.id,
          name: policyName,
          description: 'Managed by AI assistant',
          type: policyType,
          domains: [],
          categories: [],
          syncStatus: 'pending',
          isActive: true,
          createdBy: auth.user.id
        })
        .returning();
      policy = created;
    }

    if (!policy) {
      return JSON.stringify({ error: 'Failed to create or load DNS policy' });
    }

    const existing = Array.isArray(policy.domains) ? policy.domains : [];
    const domainMap = new Map<string, DnsPolicyDomain>();

    for (const item of existing) {
      const normalized = normalizeDnsDomain(item.domain);
      if (!normalized) continue;
      domainMap.set(normalized, {
        domain: normalized,
        reason: item.reason,
        addedAt: item.addedAt,
        addedBy: item.addedBy
      });
    }

    const added: string[] = [];
    const removed: string[] = [];
    const nowIso = new Date().toISOString();

    if (action === 'add_block' || action === 'add_allow') {
      for (const domain of uniqueDomains) {
        if (domainMap.has(domain)) continue;
        domainMap.set(domain, {
          domain,
          reason,
          addedAt: nowIso,
          addedBy: auth.user.id
        });
        added.push(domain);
      }
    } else {
      for (const domain of uniqueDomains) {
        if (domainMap.delete(domain)) {
          removed.push(domain);
        }
      }
    }

    await db
      .update(dnsPolicies)
      .set({
        domains: Array.from(domainMap.values()),
        syncStatus: 'pending',
        syncError: null,
        updatedAt: new Date()
      })
      .where(eq(dnsPolicies.id, policy.id));

    let syncScheduled = false;
    let warning: string | undefined;
    if (added.length > 0 || removed.length > 0) {
      try {
        await schedulePolicySync(policy.id, { add: added, remove: removed });
        syncScheduled = true;
      } catch (error) {
        console.error('[AiTools] Failed to schedule DNS policy sync:', error);
        warning = 'Policy changes were saved, but provider sync could not be scheduled';
      }
    }

    return JSON.stringify({
      success: true,
      policyId: policy.id,
      integrationId: integration.id,
      action,
      requested: uniqueDomains.length,
      added: added.length,
      removed: removed.length,
      syncScheduled,
      warning
    });
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
// get_fleet_health - Tier 1 (read-only)
// ============================================

registerTool({
  tier: 1,
  definition: {
    name: 'get_fleet_health',
    description: 'Query device reliability scores across the fleet. Returns devices ranked by reliability (worst first) with uptime, crash history, and failure metrics.',
    input_schema: {
      type: 'object' as const,
      properties: {
        orgId: { type: 'string', description: 'Optional org UUID (must be accessible)' },
        siteId: { type: 'string', description: 'Optional site UUID' },
        scoreRange: { type: 'string', enum: ['critical', 'poor', 'fair', 'good'], description: 'Score range filter' },
        trendDirection: { type: 'string', enum: ['improving', 'stable', 'degrading'], description: 'Trend direction filter' },
        issueType: { type: 'string', enum: ['crashes', 'hangs', 'hardware', 'services', 'uptime'], description: 'Issue-type filter' },
        limit: { type: 'number', description: 'Maximum results (default 25, max 100)' },
      }
    }
  },
  handler: async (input, auth) => {
    try {
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

      const limit = Math.min(Math.max(1, Number(input.limit) || 25), 100);
      const scoreRange = (typeof input.scoreRange === 'string' && ['critical', 'poor', 'fair', 'good'].includes(input.scoreRange))
        ? input.scoreRange as 'critical' | 'poor' | 'fair' | 'good'
        : undefined;
      const trendDirection = (typeof input.trendDirection === 'string' && ['improving', 'stable', 'degrading'].includes(input.trendDirection))
        ? input.trendDirection as 'improving' | 'stable' | 'degrading'
        : undefined;
      const issueType = (typeof input.issueType === 'string' && ['crashes', 'hangs', 'hardware', 'services', 'uptime'].includes(input.issueType))
        ? input.issueType as 'crashes' | 'hangs' | 'hardware' | 'services' | 'uptime'
        : undefined;

      const { total, rows } = await listReliabilityDevices({
        orgIds,
        siteId: typeof input.siteId === 'string' ? input.siteId : undefined,
        scoreRange,
        trendDirection,
        issueType,
        limit,
        offset: 0,
      });

      const avgScore = rows.length > 0
        ? Math.round(rows.reduce((sum, row) => sum + row.reliabilityScore, 0) / rows.length)
        : 0;

      return JSON.stringify({
        devices: rows,
        total,
        summary: {
          averageScore: avgScore,
          criticalDevices: rows.filter((row) => row.reliabilityScore <= 50).length,
          poorDevices: rows.filter((row) => row.reliabilityScore >= 51 && row.reliabilityScore <= 70).length,
          fairDevices: rows.filter((row) => row.reliabilityScore >= 71 && row.reliabilityScore <= 85).length,
          goodDevices: rows.filter((row) => row.reliabilityScore >= 86).length,
          degradingDevices: rows.filter((row) => row.trendDirection === 'degrading').length,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      console.error('[fleet:get_fleet_health]', message, err);
      return JSON.stringify({ error: 'Operation failed. Check server logs for details.' });
    }
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

// ============================================
// query_change_log - Tier 1 (read-only)
// ============================================

registerTool({
  tier: 1,
  definition: {
    name: 'query_change_log',
    description: 'Search device configuration changes such as software installs/updates, service changes, startup drift, network changes, scheduled task changes, and user account changes.',
    input_schema: {
      type: 'object' as const,
      properties: {
        deviceId: { type: 'string', description: 'Optional device UUID to scope results to a specific device' },
        startTime: { type: 'string', description: 'Optional ISO timestamp lower bound (inclusive)' },
        endTime: { type: 'string', description: 'Optional ISO timestamp upper bound (inclusive)' },
        changeType: {
          type: 'string',
          enum: ['software', 'service', 'startup', 'network', 'scheduled_task', 'user_account'],
          description: 'Optional change category filter'
        },
        changeAction: {
          type: 'string',
          enum: ['added', 'removed', 'modified', 'updated'],
          description: 'Optional change action filter'
        },
        limit: { type: 'number', description: 'Max results to return (default 100, max 500)' }
      }
    }
  },
  handler: async (input, auth) => {
    const conditions: SQL[] = [];
    const orgCondition = auth.orgCondition(deviceChangeLog.orgId);
    if (orgCondition) conditions.push(orgCondition);

    if (input.deviceId) {
      const access = await verifyDeviceAccess(input.deviceId as string, auth);
      if ('error' in access) return JSON.stringify({ error: access.error });
      conditions.push(eq(deviceChangeLog.deviceId, input.deviceId as string));
    }

    if (input.startTime) {
      conditions.push(gte(deviceChangeLog.timestamp, new Date(input.startTime as string)));
    }

    if (input.endTime) {
      conditions.push(lte(deviceChangeLog.timestamp, new Date(input.endTime as string)));
    }

    if (input.changeType) {
      conditions.push(eq(deviceChangeLog.changeType, input.changeType as any));
    }

    if (input.changeAction) {
      conditions.push(eq(deviceChangeLog.changeAction, input.changeAction as any));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
    const limit = Math.min(Math.max(1, Number(input.limit) || 100), 500);

    const [changes, countResult] = await Promise.all([
      db
        .select({
          timestamp: deviceChangeLog.timestamp,
          changeType: deviceChangeLog.changeType,
          changeAction: deviceChangeLog.changeAction,
          subject: deviceChangeLog.subject,
          beforeValue: deviceChangeLog.beforeValue,
          afterValue: deviceChangeLog.afterValue,
          details: deviceChangeLog.details,
          hostname: devices.hostname,
          deviceId: deviceChangeLog.deviceId
        })
        .from(deviceChangeLog)
        .leftJoin(devices, eq(deviceChangeLog.deviceId, devices.id))
        .where(whereClause)
        .orderBy(desc(deviceChangeLog.timestamp))
        .limit(limit),
      db
        .select({ count: sql<number>`count(*)` })
        .from(deviceChangeLog)
        .where(whereClause)
    ]);

    return JSON.stringify({
      changes,
      total: Number(countResult[0]?.count ?? 0),
      showing: changes.length,
      filters: {
        deviceId: input.deviceId ?? null,
        startTime: input.startTime ?? null,
        endTime: input.endTime ?? null,
        changeType: input.changeType ?? null,
        changeAction: input.changeAction ?? null
      }
    });
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
      if (!screenshotData.imageBase64) {
        console.error(`[AiTools] take_screenshot returned no imageBase64 data for device ${deviceId}`);
        return JSON.stringify({ error: 'Screenshot captured but no image data returned by agent' });
      }
      return JSON.stringify({
        imageBase64: screenshotData.imageBase64,
        width: screenshotData.width,
        height: screenshotData.height,
        format: screenshotData.format,
        sizeBytes: screenshotData.sizeBytes,
        monitor: screenshotData.monitor,
        capturedAt: screenshotData.capturedAt
      });
    } catch (err) {
      const rawPreview = (result.stdout ?? '').slice(0, 200);
      console.error(`[AiTools] Failed to parse take_screenshot response:`, err, 'Raw stdout preview:', rawPreview);
      return JSON.stringify({ error: 'Failed to parse screenshot response' });
    }
  }
});

// ============================================
// analyze_screen - Tier 2 (auto-execute + audit)
// ============================================

registerTool({
  tier: 2,
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
      if (!screenshotData.imageBase64) {
        console.error(`[AiTools] analyze_screen returned no imageBase64 data for device ${deviceId}`);
        return JSON.stringify({ error: 'Screenshot captured but no image data returned by agent' });
      }
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
    } catch (err) {
      const rawPreview = (result.stdout ?? '').slice(0, 200);
      console.error(`[AiTools] Failed to parse analyze_screen response:`, err, 'Raw stdout preview:', rawPreview);
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
    description: 'Control a device by sending mouse/keyboard input and capturing screenshots. Returns a screenshot after each action by default (configurable via captureAfter). Actions: screenshot, left_click, right_click, middle_click, double_click, mouse_move, scroll, key, type.',
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
        screenshotError: data.screenshotError || undefined,
      });
    } catch (err) {
      const rawPreview = (result.stdout ?? '').slice(0, 200);
      console.error(`[AiTools] Failed to parse computer_control response:`, err, 'Raw stdout preview:', rawPreview);
      return JSON.stringify({ error: 'Failed to parse computer action response' });
    }
  }
});

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
// get_software_compliance - Tier 1 (auto-execute)
// ============================================

registerTool({
  tier: 1,
  definition: {
    name: 'get_software_compliance',
    description: 'Check software compliance status across the fleet. Shows policy violations, unauthorized installations, and missing required software.',
    input_schema: {
      type: 'object' as const,
      properties: {
        policyId: { type: 'string', description: 'Filter by specific policy ID' },
        deviceIds: { type: 'array', items: { type: 'string' }, description: 'Filter by device IDs' },
        status: { type: 'string', enum: ['compliant', 'violation', 'unknown'], description: 'Filter by compliance status' },
        limit: { type: 'number', description: 'Max results (default 50, max 500)' },
      },
    },
  },
  handler: async (input, auth) => {
    const conditions: SQL[] = [];
    const orgCondition = auth.orgCondition(devices.orgId);
    if (orgCondition) conditions.push(orgCondition);
    if (typeof input.policyId === 'string') conditions.push(eq(softwareComplianceStatus.policyId, input.policyId));
    if (typeof input.status === 'string') conditions.push(eq(softwareComplianceStatus.status, input.status));
    if (Array.isArray(input.deviceIds) && input.deviceIds.length > 0) {
      conditions.push(inArray(softwareComplianceStatus.deviceId, input.deviceIds as string[]));
    }

    const limit = Math.min(Math.max(1, Number(input.limit) || 50), 500);

    const rows = await db
      .select({
        compliance: {
          policyId: softwareComplianceStatus.policyId,
          deviceId: softwareComplianceStatus.deviceId,
          status: softwareComplianceStatus.status,
          violations: softwareComplianceStatus.violations,
          lastChecked: softwareComplianceStatus.lastChecked,
          remediationStatus: softwareComplianceStatus.remediationStatus,
        },
        policy: {
          id: softwarePolicies.id,
          name: softwarePolicies.name,
          mode: softwarePolicies.mode,
        },
        device: {
          id: devices.id,
          hostname: devices.hostname,
        },
      })
      .from(softwareComplianceStatus)
      .innerJoin(softwarePolicies, eq(softwareComplianceStatus.policyId, softwarePolicies.id))
      .innerJoin(devices, eq(softwareComplianceStatus.deviceId, devices.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(softwareComplianceStatus.lastChecked))
      .limit(limit);

    return JSON.stringify({
      count: rows.length,
      compliance: rows.map((row) => ({
        device: row.device.hostname,
        policy: row.policy.name,
        mode: row.policy.mode,
        status: row.compliance.status,
        violations: row.compliance.violations ?? [],
        remediationStatus: row.compliance.remediationStatus ?? 'none',
        lastChecked: row.compliance.lastChecked,
      })),
    });
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
          steps: playbook.steps,
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
// manage_software_policy - Tier 3 (requires approval)
// ============================================

registerTool({
  tier: 3,
  definition: {
    name: 'manage_software_policy',
    description: 'Create, update, disable (soft-delete), list, or fetch software policies (allowlist/blocklist/audit).',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['create', 'update', 'delete', 'list', 'get'], description: 'Action to perform' },
        policyId: { type: 'string', description: 'Policy ID (for update/delete/get)' },
        orgId: { type: 'string', description: 'Organization ID (required for create in partner/system scope)' },
        name: { type: 'string', description: 'Policy name' },
        description: { type: 'string', description: 'Policy description' },
        mode: { type: 'string', enum: ['allowlist', 'blocklist', 'audit'], description: 'Policy mode' },
        software: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              vendor: { type: 'string' },
              minVersion: { type: 'string' },
              maxVersion: { type: 'string' },
              catalogId: { type: 'string' },
              reason: { type: 'string' },
            },
          },
          description: 'Software rule definitions',
        },
        allowUnknown: { type: 'boolean', description: 'Allow unmatched software in allowlist mode' },
        targetType: { type: 'string', enum: ['organization', 'site', 'device_group', 'devices'], description: 'Target scope' },
        targetIds: { type: 'array', items: { type: 'string' }, description: 'Target IDs' },
        priority: { type: 'number', description: 'Policy priority (0-100)' },
        enforceMode: { type: 'boolean', description: 'Auto-remediate violations' },
        isActive: { type: 'boolean', description: 'Enable/disable policy' },
        remediationOptions: { type: 'object', description: 'Remediation behavior options' },
        limit: { type: 'number', description: 'List limit (default 50)' },
      },
      required: ['action'],
    },
  },
  handler: async (input, auth) => {
    const action = input.action as string;

    if (action === 'list') {
      const conditions: SQL[] = [];
      const orgCondition = auth.orgCondition(softwarePolicies.orgId);
      if (orgCondition) conditions.push(orgCondition);
      if (typeof input.mode === 'string') conditions.push(eq(softwarePolicies.mode, input.mode as 'allowlist' | 'blocklist' | 'audit'));
      if (typeof input.isActive === 'boolean') conditions.push(eq(softwarePolicies.isActive, input.isActive));

      const limit = Math.min(Math.max(1, Number(input.limit) || 50), 200);
      const rows = await db
        .select()
        .from(softwarePolicies)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(softwarePolicies.priority), desc(softwarePolicies.updatedAt))
        .limit(limit);

      return JSON.stringify({ policies: rows, showing: rows.length });
    }

    if (action === 'get') {
      if (!input.policyId) return JSON.stringify({ error: 'policyId is required' });
      const conditions: SQL[] = [eq(softwarePolicies.id, input.policyId as string)];
      const orgCondition = auth.orgCondition(softwarePolicies.orgId);
      if (orgCondition) conditions.push(orgCondition);

      const [policy] = await db.select().from(softwarePolicies).where(and(...conditions)).limit(1);
      if (!policy) return JSON.stringify({ error: 'Policy not found or access denied' });

      return JSON.stringify({ policy });
    }

    if (action === 'create') {
      if (typeof input.name !== 'string' || typeof input.mode !== 'string' || typeof input.targetType !== 'string') {
        return JSON.stringify({ error: 'name, mode, and targetType are required for create' });
      }

      const orgResolution = resolveWritableToolOrgId(auth, typeof input.orgId === 'string' ? input.orgId : undefined);
      if (!orgResolution.orgId) return JSON.stringify({ error: orgResolution.error });

      const targetType = input.targetType as 'organization' | 'site' | 'device_group' | 'devices';
      const targetIds = Array.isArray(input.targetIds)
        ? Array.from(new Set((input.targetIds as string[]).filter((id) => typeof id === 'string' && id.length > 0)))
        : [];

      if (targetType !== 'organization' && targetIds.length === 0) {
        return JSON.stringify({ error: `targetIds are required for targetType "${targetType}"` });
      }

      const rules = normalizeSoftwarePolicyRules({
        software: Array.isArray(input.software) ? input.software : [],
        allowUnknown: input.allowUnknown === true,
      });
      if (rules.software.length === 0) {
        return JSON.stringify({ error: 'At least one software rule is required' });
      }

      const [policy] = await db
        .insert(softwarePolicies)
        .values({
          orgId: orgResolution.orgId,
          name: input.name as string,
          description: (input.description as string) ?? null,
          mode: input.mode as 'allowlist' | 'blocklist' | 'audit',
          rules,
          targetType,
          targetIds: targetType === 'organization' ? null : targetIds,
          priority: Math.min(100, Math.max(0, Number(input.priority) || 50)),
          enforceMode: input.enforceMode === true,
          remediationOptions: (input.remediationOptions as Record<string, unknown>) ?? null,
          createdBy: auth.user.id,
        })
        .returning();

      let scheduleWarning: string | undefined;
      try {
        await scheduleSoftwareComplianceCheck(policy.id);
      } catch (error) {
        scheduleWarning = error instanceof Error ? error.message : 'Failed to schedule compliance check';
        console.error(`[aiTools] Failed to schedule compliance check for policy ${policy.id}:`, error);
      }
      return JSON.stringify({ success: true, policyId: policy.id, name: policy.name, ...(scheduleWarning ? { warning: scheduleWarning } : {}) });
    }

    if (action === 'update') {
      if (!input.policyId) return JSON.stringify({ error: 'policyId is required' });

      const conditions: SQL[] = [eq(softwarePolicies.id, input.policyId as string)];
      const orgCondition = auth.orgCondition(softwarePolicies.orgId);
      if (orgCondition) conditions.push(orgCondition);

      const [existing] = await db.select().from(softwarePolicies).where(and(...conditions)).limit(1);
      if (!existing) return JSON.stringify({ error: 'Policy not found or access denied' });

      const updates: Partial<typeof softwarePolicies.$inferInsert> = { updatedAt: new Date() };
      if (typeof input.name === 'string') updates.name = input.name;
      if (typeof input.description === 'string') updates.description = input.description;
      if (typeof input.mode === 'string') updates.mode = input.mode as 'allowlist' | 'blocklist' | 'audit';
      if (typeof input.priority === 'number') updates.priority = Math.min(100, Math.max(0, Number(input.priority)));
      if (typeof input.enforceMode === 'boolean') updates.enforceMode = input.enforceMode;
      if (typeof input.isActive === 'boolean') updates.isActive = input.isActive;
      if (input.remediationOptions && typeof input.remediationOptions === 'object') {
        updates.remediationOptions = input.remediationOptions as Record<string, unknown>;
      }

      if (Array.isArray(input.software) || input.allowUnknown !== undefined) {
        const existingRules = (existing.rules ?? {}) as { software?: unknown; allowUnknown?: boolean };
        const rules = normalizeSoftwarePolicyRules({
          software: Array.isArray(input.software) ? input.software : existingRules.software,
          allowUnknown: typeof input.allowUnknown === 'boolean'
            ? input.allowUnknown
            : existingRules.allowUnknown === true,
        });
        if (rules.software.length === 0) {
          return JSON.stringify({ error: 'At least one software rule is required' });
        }
        updates.rules = rules;
      }

      if (typeof input.targetType === 'string' || Array.isArray(input.targetIds)) {
        const targetType = (input.targetType as 'organization' | 'site' | 'device_group' | 'devices') ?? existing.targetType;
        const targetIds = Array.isArray(input.targetIds)
          ? Array.from(new Set((input.targetIds as string[]).filter((id) => typeof id === 'string' && id.length > 0)))
          : Array.isArray(existing.targetIds)
            ? existing.targetIds
            : [];

        if (targetType !== 'organization' && targetIds.length === 0) {
          return JSON.stringify({ error: `targetIds are required for targetType "${targetType}"` });
        }

        updates.targetType = targetType;
        updates.targetIds = targetType === 'organization' ? null : targetIds;
      }

      const [updated] = await db
        .update(softwarePolicies)
        .set(updates)
        .where(eq(softwarePolicies.id, existing.id))
        .returning();

      let scheduleWarning: string | undefined;
      try {
        await scheduleSoftwareComplianceCheck(existing.id);
      } catch (error) {
        scheduleWarning = error instanceof Error ? error.message : 'Failed to schedule compliance check';
        console.error(`[aiTools] Failed to schedule compliance check for policy ${existing.id}:`, error);
      }
      return JSON.stringify({ success: true, policyId: existing.id, name: updated?.name ?? existing.name, ...(scheduleWarning ? { warning: scheduleWarning } : {}) });
    }

    if (action === 'delete') {
      if (!input.policyId) return JSON.stringify({ error: 'policyId is required' });

      const conditions: SQL[] = [eq(softwarePolicies.id, input.policyId as string)];
      const orgCondition = auth.orgCondition(softwarePolicies.orgId);
      if (orgCondition) conditions.push(orgCondition);

      const [existing] = await db.select().from(softwarePolicies).where(and(...conditions)).limit(1);
      if (!existing) return JSON.stringify({ error: 'Policy not found or access denied' });

      await db.transaction(async (tx) => {
        await tx
          .update(softwarePolicies)
          .set({ isActive: false, updatedAt: new Date() })
          .where(eq(softwarePolicies.id, existing.id));

        await tx
          .delete(softwareComplianceStatus)
          .where(eq(softwareComplianceStatus.policyId, existing.id));
      });

      return JSON.stringify({ success: true, message: `Policy "${existing.name}" disabled` });
    }

    return JSON.stringify({ error: `Unknown action: ${action}` });
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

// ============================================
// remediate_software_violation - Tier 3 (requires approval)
// ============================================

registerTool({
  tier: 3,
  definition: {
    name: 'remediate_software_violation',
    description: 'Queue remediation for software policy violations by scheduling uninstall commands for unauthorized software.',
    input_schema: {
      type: 'object' as const,
      properties: {
        deviceIds: { type: 'array', items: { type: 'string' }, description: 'Devices to remediate' },
        policyId: { type: 'string', description: 'Policy ID' },
        autoUninstall: { type: 'boolean', description: 'Whether to queue uninstall commands (default true)' },
      },
      required: ['policyId'],
    },
  },
  handler: async (input, auth) => {
    const policyId = input.policyId as string;
    const autoUninstall = input.autoUninstall !== false;
    if (!autoUninstall) {
      return JSON.stringify({ error: 'autoUninstall=false is not supported for this remediation action' });
    }

    const conditions: SQL[] = [eq(softwarePolicies.id, policyId)];
    const orgCondition = auth.orgCondition(softwarePolicies.orgId);
    if (orgCondition) conditions.push(orgCondition);

    const [policy] = await db.select().from(softwarePolicies).where(and(...conditions)).limit(1);
    if (!policy) return JSON.stringify({ error: 'Policy not found or access denied' });
    if (policy.mode === 'audit') return JSON.stringify({ error: 'Cannot remediate audit-only policy' });

    let deviceIds = Array.isArray(input.deviceIds)
      ? Array.from(new Set((input.deviceIds as string[]).filter((id) => typeof id === 'string' && id.length > 0)))
      : [];

    if (deviceIds.length === 0) {
      const complianceConditions: SQL[] = [
        eq(softwareComplianceStatus.policyId, policy.id),
        eq(softwareComplianceStatus.status, 'violation'),
      ];
      const deviceOrgCondition = auth.orgCondition(devices.orgId);
      if (deviceOrgCondition) complianceConditions.push(deviceOrgCondition);

      const rows = await db
        .select({ deviceId: softwareComplianceStatus.deviceId })
        .from(softwareComplianceStatus)
        .innerJoin(devices, eq(softwareComplianceStatus.deviceId, devices.id))
        .where(and(...complianceConditions));

      deviceIds = Array.from(new Set(rows.map((row) => row.deviceId)));
    }

    if (deviceIds.length === 0) {
      return JSON.stringify({ message: 'No matching violation rows found for remediation', queued: 0 });
    }

    let queued: number;
    try {
      queued = await scheduleSoftwareRemediation(policy.id, deviceIds);
    } catch (error) {
      console.error(`[aiTools] Failed to schedule remediation for policy ${policy.id}:`, error);
      return JSON.stringify({ error: 'Failed to schedule remediation', policyId: policy.id });
    }
    return JSON.stringify({
      message: `Remediation scheduled for ${queued} device(s)`,
      policyId: policy.id,
      queued,
      deviceIds,
    });
  },
});

// ============================================
// Fleet Orchestration Tools (8 tools)
// ============================================

registerFleetTools(aiTools);
registerAgentLogTools(aiTools);
registerConfigPolicyTools(aiTools);
registerEventLogTools(aiTools);

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
