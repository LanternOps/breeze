/**
 * AI Network Tools
 *
 * Tools for network change monitoring, baseline configuration, IP history, and discovery.
 * - get_network_changes (Tier 1): Query network change events
 * - acknowledge_network_device (Tier 2): Acknowledge a network change event
 * - configure_network_baseline (Tier 2): Create/update network baseline configuration
 * - get_ip_history (Tier 1): Query historical IP assignments
 * - network_discovery (Tier 3): Initiate a network discovery scan
 */

import { isIP } from 'node:net';
import { db } from '../db';
import {
  devices,
  deviceIpHistory,
  networkBaselines,
  networkChangeEvents,
  sites,
} from '../db/schema';
import { eq, and, desc, gte, lte, SQL } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import {
  normalizeBaselineAlertSettings,
  normalizeBaselineScanSchedule,
} from './networkBaseline';

type AiToolTier = 1 | 2 | 3 | 4;

// ============================================
// Local helpers
// ============================================

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

// ============================================
// Registration
// ============================================

export function registerNetworkTools(aiTools: Map<string, AiTool>): void {
  function registerTool(tool: AiTool): void {
    aiTools.set(tool.definition.name, tool);
  }

  // ============================================
  // 1. get_network_changes - Tier 1 (read-only)
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
  // 2. acknowledge_network_device - Tier 2 (mutating)
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
  // 3. configure_network_baseline - Tier 2 (mutating)
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
  // 4. get_ip_history - Tier 1 (auto-execute)
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
  // 5. network_discovery - Tier 3 (requires approval)
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
}
