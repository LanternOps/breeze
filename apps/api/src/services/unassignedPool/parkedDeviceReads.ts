/**
 * The one human-facing read of parked devices: the pre-assignment list shown
 * to full partner admins (routes/preAssignment.ts). Runs in a fresh system
 * context bound to ONE partner id the route resolved — the holding org is
 * never in a human caller's accessibleOrgIds, so a request context would see
 * nothing.
 *
 * Every identity field here (hostname, OS, serial, MAC, model) is reported by
 * the device and unverified.
 */
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { deviceHardware, devices, organizations } from '../../db/schema';
import { UNASSIGNED_POOL_ORG_TYPE } from './orgType';

export interface ParkedDeviceListItem {
  id: string;
  hostname: string;
  osType: string;
  osVersion: string;
  agentVersion: string;
  status: string;
  serialNumber: string | null;
  manufacturer: string | null;
  model: string | null;
  primaryMacAddress: string | null;
  parkedAt: string;
  lastSeenAt: string | null;
  deployKeyName: string | null;
}

/** Upper bound on one listing; the per-partner parking cap is far below it. */
const LIST_LIMIT = 500;

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export async function listParkedDevices(partnerId: string): Promise<ParkedDeviceListItem[]> {
  const rows = await runOutsideDbContext(() => withSystemDbAccessContext(() => db
    .select({
      id: devices.id,
      hostname: devices.hostname,
      osType: devices.osType,
      osVersion: devices.osVersion,
      agentVersion: devices.agentVersion,
      status: devices.status,
      serialNumber: deviceHardware.serialNumber,
      manufacturer: deviceHardware.manufacturer,
      model: deviceHardware.model,
      primaryMacAddress: sql<string | null>`(
        SELECT dn.mac_address FROM device_network dn
         WHERE dn.device_id = ${devices.id} AND dn.is_primary
         ORDER BY dn.mac_address LIMIT 1)`,
      parkedAt: devices.createdAt,
      lastSeenAt: devices.lastSeenAt,
      deployKeyName: sql<string | null>`(
        SELECT e.deploy_key_name FROM device_pool_assignment_events e
         WHERE e.device_id = ${devices.id} AND e.event_type = 'enrolled'
         ORDER BY e.created_at DESC LIMIT 1)`,
    })
    .from(devices)
    .innerJoin(organizations, eq(organizations.id, devices.orgId))
    .leftJoin(deviceHardware, eq(deviceHardware.deviceId, devices.id))
    .where(and(
      eq(organizations.partnerId, partnerId),
      eq(organizations.type, UNASSIGNED_POOL_ORG_TYPE),
      ne(devices.status, 'decommissioned'),
    ))
    .orderBy(desc(devices.createdAt))
    .limit(LIST_LIMIT)));

  return rows.map((row) => ({
    ...row,
    parkedAt: iso(row.parkedAt)!,
    lastSeenAt: iso(row.lastSeenAt),
  }));
}
