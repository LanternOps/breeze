import { db } from '../db';
import { deviceGroups } from '../db/schema';
import { eq, or } from 'drizzle-orm';
import { sql } from 'drizzle-orm';

/**
 * Event types that can trigger device change processing
 */
export type DeviceChangeEventType =
  | 'device.created'
  | 'device.updated'
  | 'device.deleted'
  | 'device.hardware_updated'
  | 'device.network_updated'
  | 'device.metrics_updated'
  | 'device.software_changed';

export interface DeviceChangeEvent {
  type: DeviceChangeEventType;
  deviceId: string;
  orgId: string;
  changedFields: string[];
  previousValues?: Record<string, unknown>;
  newValues?: Record<string, unknown>;
  timestamp: Date;
}

/**
 * Registry of event handlers
 */
type DeviceEventHandler = (event: DeviceChangeEvent) => Promise<void>;
const eventHandlers: Map<DeviceChangeEventType, DeviceEventHandler[]> = new Map();

/**
 * Register a handler for a device change event type
 */
export function onDeviceChange(eventType: DeviceChangeEventType, handler: DeviceEventHandler): void {
  const handlers = eventHandlers.get(eventType) || [];
  handlers.push(handler);
  eventHandlers.set(eventType, handlers);
}

/**
 * Emit a device change event
 */
export async function emitDeviceChange(event: DeviceChangeEvent): Promise<void> {
  const handlers = eventHandlers.get(event.type) || [];

  // Run all handlers (don't fail if one handler fails)
  await Promise.allSettled(
    handlers.map(handler => handler(event))
  );
}

/**
 * Find groups that filter on any of the specified fields
 */
export async function getGroupsFilteringOnFields(
  orgId: string,
  changedFields: string[]
): Promise<Array<{ id: string; name: string; filterConditions: unknown }>> {
  if (changedFields.length === 0) {
    return [];
  }

  // Query groups where filterFieldsUsed overlaps with changedFields
  const groups = await db
    .select({
      id: deviceGroups.id,
      name: deviceGroups.name,
      filterConditions: deviceGroups.filterConditions
    })
    .from(deviceGroups)
    .where(
      sql`${deviceGroups.orgId} = ${orgId}
        AND ${deviceGroups.type} = 'dynamic'
        AND ${deviceGroups.filterConditions} IS NOT NULL
        AND ${deviceGroups.filterFieldsUsed} && ${changedFields}`
    );

  return groups;
}

/**
 * Map field changes from device update payload to filter field names
 */
export function mapChangedFieldsToFilterFields(
  changedFields: string[],
  source: 'device' | 'hardware' | 'network' | 'metrics' | 'software' = 'device'
): string[] {
  const prefixMap: Record<string, string> = {
    device: '',
    hardware: 'hardware.',
    network: 'network.',
    metrics: 'metrics.',
    software: 'software.'
  };

  const prefix = prefixMap[source] || '';

  // Map common device fields to their filter field names
  const fieldMappings: Record<string, string> = {
    hostname: 'hostname',
    displayName: 'displayName',
    status: 'status',
    agentVersion: 'agentVersion',
    enrolledAt: 'enrolledAt',
    lastSeenAt: 'lastSeenAt',
    tags: 'tags',
    osType: 'osType',
    osVersion: 'osVersion',
    osBuild: 'osBuild',
    architecture: 'architecture',
    customFields: 'custom', // Special handling needed for custom fields
    // Hardware fields
    cpuModel: 'hardware.cpuModel',
    cpuCores: 'hardware.cpuCores',
    ramTotalMb: 'hardware.ramTotalMb',
    diskTotalGb: 'hardware.diskTotalGb',
    gpuModel: 'hardware.gpuModel',
    serialNumber: 'hardware.serialNumber',
    manufacturer: 'hardware.manufacturer',
    model: 'hardware.model',
    // Network fields
    ipAddress: 'network.ipAddress',
    publicIp: 'network.publicIp',
    macAddress: 'network.macAddress',
    // Metrics
    cpuPercent: 'metrics.cpuPercent',
    ramPercent: 'metrics.ramPercent',
    diskPercent: 'metrics.diskPercent'
  };

  return changedFields.map(field => {
    // If already has prefix, return as-is
    if (field.includes('.')) {
      return field;
    }
    // Look up mapping, or apply prefix
    return fieldMappings[field] || `${prefix}${field}`;
  }).filter(Boolean);
}

/**
 * Create a device change event from an update operation
 */
export function createDeviceChangeEvent(
  type: DeviceChangeEventType,
  deviceId: string,
  orgId: string,
  changedFields: string[],
  previousValues?: Record<string, unknown>,
  newValues?: Record<string, unknown>
): DeviceChangeEvent {
  return {
    type,
    deviceId,
    orgId,
    changedFields,
    previousValues,
    newValues,
    timestamp: new Date()
  };
}

/**
 * Initialize default event handlers
 * This should be called during app startup
 */
export function initializeDeviceEventHandlers(): void {
  // Import here to avoid circular dependencies
  const { updateDeviceMemberships } = require('../services/groupMembership');

  // Handler for device updates - re-evaluate group memberships
  onDeviceChange('device.updated', async (event) => {
    if (event.changedFields.length > 0) {
      await updateDeviceMemberships(
        event.deviceId,
        event.orgId,
        mapChangedFieldsToFilterFields(event.changedFields, 'device')
      );
    }
  });

  // Handler for hardware updates
  onDeviceChange('device.hardware_updated', async (event) => {
    await updateDeviceMemberships(
      event.deviceId,
      event.orgId,
      mapChangedFieldsToFilterFields(event.changedFields, 'hardware')
    );
  });

  // Handler for network updates
  onDeviceChange('device.network_updated', async (event) => {
    await updateDeviceMemberships(
      event.deviceId,
      event.orgId,
      mapChangedFieldsToFilterFields(event.changedFields, 'network')
    );
  });

  // Handler for software changes
  onDeviceChange('device.software_changed', async (event) => {
    await updateDeviceMemberships(
      event.deviceId,
      event.orgId,
      ['software.installed', 'software.notInstalled']
    );
  });

  // Handler for device creation - add to matching dynamic groups
  onDeviceChange('device.created', async (event) => {
    // Get all dynamic groups for the org and evaluate membership
    const groups = await db
      .select({ id: deviceGroups.id })
      .from(deviceGroups)
      .where(
        sql`${deviceGroups.orgId} = ${event.orgId}
          AND ${deviceGroups.type} = 'dynamic'
          AND ${deviceGroups.filterConditions} IS NOT NULL`
      );

    for (const group of groups) {
      try {
        // Evaluate if device matches the group's filter
        const { evaluateDeviceMembershipForGroup } = require('../services/groupMembership');
        await evaluateDeviceMembershipForGroup(group.id, event.deviceId);
      } catch (error) {
        console.error(`Failed to evaluate membership for group ${group.id}:`, error);
      }
    }
  });

  // Handler for device deletion - remove from all groups
  onDeviceChange('device.deleted', async (event) => {
    const { removeDeviceFromAllGroups } = require('../services/groupMembership');
    await removeDeviceFromAllGroups(event.deviceId);
  });
}
