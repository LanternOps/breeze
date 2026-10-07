import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db';
import {
  deviceConnections,
  deviceHardware,
  deviceMemoryModules,
  deviceNetwork,
  devices,
} from '../../db/schema';

// Customer-portal read model for the `enableHardwareInventory` family
// (Portal Advanced Visibility W02, #7732).
//
// Safety rules, enforced here and covered by the contract test:
//   - The organization always comes from the portal session, never the request.
//   - Every select names its columns explicitly (no row spreading), so a column
//     added to a table later is never exposed by accident.
//   - Managed-device identifiers stay out: serial numbers (device and memory
//     modules), part numbers, module manufacturer, MAC addresses, public IP.
//   - Connections are aggregate counts by protocol and state only: never an
//     address, a port, a process id or a process name.
//   - Adapters on tunnel and overlay interfaces (WireGuard, Tailscale,
//     ZeroTier and similar) are skipped, so the portal does not reveal
//     overlay topology.

const iso = (value: Date | null | undefined) => (value ? value.toISOString() : null);

// Interface names of VPN, tunnel and overlay adapters across the supported OSes.
const OVERLAY_INTERFACE_NAME =
  /(tailscale|wireguard|zerotier|nebula|wintun|^wg\d|^utun\d|^tun\d|^tap\d|^zt)/i;

// Addresses the common overlays hand out: the CGNAT block 100.64.0.0/10 (used
// by Tailscale) and Tailscale's IPv6 ULA prefix.
export function isOverlayAddress(ip: string | null | undefined): boolean {
  if (!ip) return false;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(ip);
  if (v4) {
    const first = Number(v4[1]);
    const second = Number(v4[2]);
    return first === 100 && second >= 64 && second <= 127;
  }
  return ip.toLowerCase().startsWith('fd7a:115c:a1e0');
}

export function isOverlayAdapter(name: string, ip: string | null | undefined): boolean {
  return OVERLAY_INTERFACE_NAME.test(name) || isOverlayAddress(ip);
}

async function deviceTotal(orgId: string): Promise<number> {
  const rows = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(devices)
    .where(and(eq(devices.orgId, orgId), eq(devices.isEphemeral, false)));
  return rows[0]?.total ?? 0;
}

// Devices of the whole organization that have reported inventory. Used for the
// list's dataStatus so it does not depend on which page was requested.
async function reportingTotal(orgId: string): Promise<number> {
  const rows = await db
    .select({ reporting: sql<number>`count(*)::int` })
    .from(deviceHardware)
    .innerJoin(devices, eq(devices.id, deviceHardware.deviceId))
    .where(and(
      eq(deviceHardware.orgId, orgId),
      eq(devices.orgId, orgId),
      eq(devices.isEphemeral, false),
    ));
  return rows[0]?.reporting ?? 0;
}

export async function hardwareInventoryDevicesPage(
  orgId: string,
  args: { page: number; limit: number; now: Date },
) {
  const offset = (args.page - 1) * args.limit;
  const [total, reporting, pageRows] = await Promise.all([
    deviceTotal(orgId),
    reportingTotal(orgId),
    db
      .select({
        id: devices.id,
        hostname: devices.hostname,
        displayName: devices.displayName,
        osType: devices.osType,
      })
      .from(devices)
      .where(and(eq(devices.orgId, orgId), eq(devices.isEphemeral, false)))
      .orderBy(asc(sql`coalesce(${devices.displayName}, ${devices.hostname})`), asc(devices.id))
      .limit(args.limit)
      .offset(offset),
  ]);

  const ids = pageRows.map((row) => row.id);
  const hardwareRows = ids.length === 0
    ? []
    : await db
      .select({
        deviceId: deviceHardware.deviceId,
        manufacturer: deviceHardware.manufacturer,
        model: deviceHardware.model,
        cpuModel: deviceHardware.cpuModel,
        cpuCores: deviceHardware.cpuCores,
        cpuThreads: deviceHardware.cpuThreads,
        ramTotalMb: deviceHardware.ramTotalMb,
        diskTotalGb: deviceHardware.diskTotalGb,
      })
      .from(deviceHardware)
      .where(and(eq(deviceHardware.orgId, orgId), inArray(deviceHardware.deviceId, ids)));
  const byDevice = new Map(hardwareRows.map((row) => [row.deviceId, row]));

  const data = pageRows.map((row) => {
    const hw = byDevice.get(row.id);
    return {
      id: row.id,
      hostname: row.hostname,
      displayName: row.displayName,
      osType: row.osType,
      manufacturer: hw?.manufacturer ?? null,
      model: hw?.model ?? null,
      cpuModel: hw?.cpuModel ?? null,
      cpuCores: hw?.cpuCores ?? null,
      cpuThreads: hw?.cpuThreads ?? null,
      ramTotalMb: hw?.ramTotalMb ?? null,
      diskTotalGb: hw?.diskTotalGb ?? null,
    };
  });

  return {
    asOf: args.now.toISOString(),
    dataStatus: reporting > 0 ? ('ok' as const) : ('no_data' as const),
    data,
    pagination: { page: args.page, limit: args.limit, total },
  };
}

export async function hardwareInventoryDeviceDetail(orgId: string, deviceId: string, now: Date) {
  const deviceRows = await db
    .select({
      id: devices.id,
      hostname: devices.hostname,
      displayName: devices.displayName,
      osType: devices.osType,
    })
    .from(devices)
    .where(and(
      eq(devices.id, deviceId),
      eq(devices.orgId, orgId),
      eq(devices.isEphemeral, false),
    ))
    .limit(1);
  const device = deviceRows[0];
  if (!device) return null;

  const [hardwareRows, memoryRows, adapterRows, connectionRows] = await Promise.all([
    db
      .select({
        manufacturer: deviceHardware.manufacturer,
        model: deviceHardware.model,
        cpuModel: deviceHardware.cpuModel,
        cpuCores: deviceHardware.cpuCores,
        cpuThreads: deviceHardware.cpuThreads,
        ramTotalMb: deviceHardware.ramTotalMb,
        diskTotalGb: deviceHardware.diskTotalGb,
        gpuModel: deviceHardware.gpuModel,
        biosVersion: deviceHardware.biosVersion,
        // Read only to tell "reported" from "never reported"; never emitted.
        observedAt: deviceHardware.updatedAt,
      })
      .from(deviceHardware)
      .where(and(eq(deviceHardware.orgId, orgId), eq(deviceHardware.deviceId, deviceId)))
      .limit(1),
    db
      .select({
        slotIndex: deviceMemoryModules.slotIndex,
        locator: deviceMemoryModules.locator,
        populated: deviceMemoryModules.populated,
        capacityMb: deviceMemoryModules.capacityMb,
        memoryType: deviceMemoryModules.memoryType,
        formFactor: deviceMemoryModules.formFactor,
        speedMts: deviceMemoryModules.speedMts,
        configuredSpeedMts: deviceMemoryModules.configuredSpeedMts,
      })
      .from(deviceMemoryModules)
      .where(and(eq(deviceMemoryModules.orgId, orgId), eq(deviceMemoryModules.deviceId, deviceId)))
      .orderBy(asc(deviceMemoryModules.slotIndex)),
    db
      .select({
        interfaceName: deviceNetwork.interfaceName,
        ipAddress: deviceNetwork.ipAddress,
        ipType: deviceNetwork.ipType,
        isPrimary: deviceNetwork.isPrimary,
      })
      .from(deviceNetwork)
      .where(and(eq(deviceNetwork.orgId, orgId), eq(deviceNetwork.deviceId, deviceId)))
      .orderBy(desc(deviceNetwork.isPrimary), asc(deviceNetwork.interfaceName)),
    db
      .select({
        protocol: deviceConnections.protocol,
        state: deviceConnections.state,
        count: sql<number>`count(*)::int`,
      })
      .from(deviceConnections)
      .where(and(eq(deviceConnections.orgId, orgId), eq(deviceConnections.deviceId, deviceId)))
      .groupBy(deviceConnections.protocol, deviceConnections.state)
      .orderBy(asc(deviceConnections.protocol), asc(deviceConnections.state)),
  ]);

  const hw = hardwareRows[0];
  const groups = connectionRows.map((row) => ({
    protocol: row.protocol,
    state: row.state ?? null,
    count: row.count,
  }));

  return {
    asOf: now.toISOString(),
    dataStatus: hw ? ('ok' as const) : ('no_data' as const),
    device: {
      id: device.id,
      hostname: device.hostname,
      displayName: device.displayName,
      osType: device.osType,
    },
    hardware: hw
      ? {
        manufacturer: hw.manufacturer ?? null,
        model: hw.model ?? null,
        cpuModel: hw.cpuModel ?? null,
        cpuCores: hw.cpuCores ?? null,
        cpuThreads: hw.cpuThreads ?? null,
        ramTotalMb: hw.ramTotalMb ?? null,
        diskTotalGb: hw.diskTotalGb ?? null,
        gpuModel: hw.gpuModel ?? null,
        biosVersion: hw.biosVersion ?? null,
      }
      : null,
    memoryModules: memoryRows.map((row) => ({
      slotIndex: row.slotIndex,
      locator: row.locator,
      populated: row.populated,
      capacityMb: row.capacityMb ?? null,
      memoryType: row.memoryType ?? null,
      formFactor: row.formFactor ?? null,
      speedMts: row.speedMts ?? null,
      configuredSpeedMts: row.configuredSpeedMts ?? null,
    })),
    networkAdapters: adapterRows
      .filter((row) => !isOverlayAdapter(row.interfaceName, row.ipAddress))
      .map((row) => ({
        interfaceName: row.interfaceName,
        ipAddress: row.ipAddress ?? null,
        ipType: row.ipType,
        isPrimary: row.isPrimary,
      })),
    connections: {
      total: groups.reduce((sum, group) => sum + group.count, 0),
      groups,
    },
  };
}
