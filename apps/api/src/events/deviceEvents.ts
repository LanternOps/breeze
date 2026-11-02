import { db } from '../db';
import { SOFTWARE_GROUP_FILTER_FIELDS } from '../services/softwareGroupFilterFields';
import { deviceGroups, organizations } from '../db/schema';
import { and, eq, isNull, or } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { excludeQuickSupportOrgs } from '../services/quickSupportOrg';
import { notHoldingOrgCondition } from '../services/unassignedPool/selectorPredicate';
import {
  evaluateDeviceGroupMemberships,
  removeDeviceFromAllGroups,
  updateDeviceMemberships,
} from '../services/groupMembership';

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
 * Emit a device change event.
 *
 * One handler's failure must not stop the others — every handler is run to
 * completion via `Promise.allSettled` and every rejection is logged at error
 * level — but the failure must not vanish either. This used to RESOLVE after
 * logging, which made `attempts: 5` on the re-evaluation queue dead code: a
 * transient database failure inside evaluation completed the job "successfully"
 * and membership stayed stale forever with only a log line.
 *
 * So it now THROWS an `AggregateError` carrying every rejection once all
 * handlers have settled. Its only caller is the BullMQ processor
 * (`jobs/deviceGroupJobs.ts`), so a throw here is exactly what makes BullMQ
 * retry with backoff, and a genuinely deterministic failure still terminates
 * after `attempts` and is retained by `removeOnFail` for inspection.
 */
export async function emitDeviceChange(event: DeviceChangeEvent): Promise<void> {
  const handlers = eventHandlers.get(event.type) || [];
  if (handlers.length === 0) return;

  const results = await Promise.allSettled(
    handlers.map(handler => handler(event))
  );

  const failures: Error[] = [];
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      console.error(
        `[deviceEvents] handler #${index} for ${event.type} failed `
        + `(device ${event.deviceId}, org ${event.orgId}):`,
        result.reason,
      );
      failures.push(asError(result.reason));
    }
  });

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `[deviceEvents] ${failures.length} of ${handlers.length} handler(s) for ${event.type} `
      + `failed (device ${event.deviceId}, org ${event.orgId})`,
    );
  }
}

/** Normalise an unknown rejection reason into an Error for AggregateError. */
function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
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

  const [org] = await db.select({ partnerId: organizations.partnerId }).from(organizations)
    .where(and(eq(organizations.id, orgId), excludeQuickSupportOrgs(), notHoldingOrgCondition())).limit(1);
  const owner = or(eq(deviceGroups.orgId, orgId), org
    ? and(isNull(deviceGroups.orgId), eq(deviceGroups.partnerId, org.partnerId)) : undefined);
  // Query groups where filterFieldsUsed overlaps with changedFields
  const groups = await db
    .select({
      id: deviceGroups.id,
      name: deviceGroups.name,
      filterConditions: deviceGroups.filterConditions
    })
    .from(deviceGroups)
    .where(
      sql`(${owner})
        AND ${deviceGroups.type} = 'dynamic'
        AND ${deviceGroups.filterConditions} IS NOT NULL
        AND ${deviceGroups.filterFieldsUsed} && ${changedFields}`
    ).orderBy(deviceGroups.id);

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

let handlersInitialized = false;

/**
 * Initialize default event handlers.
 *
 * Called from `index.ts`'s bootstrap AND from the re-evaluation worker
 * (`jobs/deviceGroupJobs.ts`), because a `worker`-role process never runs
 * index.ts at all and would otherwise drain the queue with an empty registry —
 * a silent no-op. Idempotent: `eventHandlers` is an append-only module
 * singleton, so a second unguarded call would double-register every handler and
 * evaluate each device twice.
 */
export function initializeDeviceEventHandlers(): void {
  if (handlersInitialized) return;
  handlersInitialized = true;

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
      [...SOFTWARE_GROUP_FILTER_FIELDS]
    );
  });

  // Handler for device creation - add to matching dynamic groups
  onDeviceChange('device.created', async (event) => {
    await evaluateDeviceGroupMemberships(event.deviceId, { all: true });
  });

  // Handler for device deletion - remove from all groups
  onDeviceChange('device.deleted', async (event) => {
    await removeDeviceFromAllGroups(event.deviceId);
  });
}

/**
 * Test-only: drop every registered handler and re-arm
 * `initializeDeviceEventHandlers`. Production code must never call this.
 */
export function resetDeviceEventHandlersForTests(): void {
  eventHandlers.clear();
  handlersInitialized = false;
}
