import { isIP } from 'node:net';
import { and, eq, inArray, or, type SQL } from 'drizzle-orm';
import { db } from '../db';
import { deviceIpHistory } from '../db/schema';

const ASSIGNMENT_TYPES = ['dhcp', 'static', 'vpn', 'link-local', 'unknown'] as const;
type AssignmentType = (typeof ASSIGNMENT_TYPES)[number];
type IpType = 'ipv4' | 'ipv6';

interface NormalizedDeviceIPHistoryEntry {
  interfaceName: string;
  ipAddress: string;
  ipType: IpType;
  assignmentType: AssignmentType;
  macAddress: string | null;
  subnetMask: string | null;
  gateway: string | null;
  dnsServers: string[];
}

export interface DeviceIPHistoryEntryInput {
  interfaceName: string;
  ipAddress: string;
  ipType?: string;
  assignmentType?: string;
  macAddress?: string | null;
  subnetMask?: string | null;
  gateway?: string | null;
  dnsServers?: string[] | null;
}

export interface DeviceIPHistoryUpdateInput {
  deviceId?: string;
  currentIPs?: DeviceIPHistoryEntryInput[];
  changedIPs?: DeviceIPHistoryEntryInput[];
  removedIPs?: DeviceIPHistoryEntryInput[];
  detectedAt?: string;
}

function clamp(value: string, maxLen: number): string {
  return value.slice(0, maxLen);
}

function normalizeOptionalString(value: string | null | undefined, maxLen: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return clamp(trimmed, maxLen);
}

function normalizeIPAddress(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const withoutZone = trimmed.includes('%')
    ? trimmed.slice(0, Math.max(trimmed.indexOf('%'), 0))
    : trimmed;

  const parsed = isIP(withoutZone);
  if (parsed === 0) {
    console.debug(`[DeviceIpHistory] dropping invalid IP address: ${value}`);
    return null;
  }

  return parsed === 6 ? withoutZone.toLowerCase() : withoutZone;
}

function normalizeIpType(value: string | undefined, ipAddress: string): IpType {
  const inferred = isIP(ipAddress);
  if (inferred === 6) return 'ipv6';
  if (inferred === 4) return 'ipv4';
  return value?.trim().toLowerCase() === 'ipv6' ? 'ipv6' : 'ipv4';
}

function normalizeAssignmentType(value: string | undefined): AssignmentType {
  const normalized = value?.trim().toLowerCase();
  return (ASSIGNMENT_TYPES as readonly string[]).includes(normalized ?? '')
    ? (normalized as AssignmentType)
    : 'unknown';
}

function normalizeDnsServers(value: string[] | null | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => normalizeIPAddress(entry))
    .filter((entry): entry is string => Boolean(entry))
    .slice(0, 8);
}

function normalizeEntry(entry: DeviceIPHistoryEntryInput | undefined): NormalizedDeviceIPHistoryEntry | null {
  if (!entry || typeof entry.interfaceName !== 'string' || typeof entry.ipAddress !== 'string') {
    return null;
  }

  const interfaceName = entry.interfaceName.trim();
  const ipAddress = normalizeIPAddress(entry.ipAddress);
  if (!interfaceName || !ipAddress) {
    return null;
  }

  return {
    interfaceName: clamp(interfaceName, 100),
    ipAddress: clamp(ipAddress, 45),
    ipType: normalizeIpType(entry.ipType, ipAddress),
    assignmentType: normalizeAssignmentType(entry.assignmentType),
    macAddress: normalizeOptionalString(entry.macAddress, 17),
    subnetMask: normalizeOptionalString(entry.subnetMask, 45),
    gateway: normalizeOptionalString(entry.gateway, 45),
    dnsServers: normalizeDnsServers(entry.dnsServers),
  };
}

function dedupeEntries(entries: DeviceIPHistoryEntryInput[] | undefined): NormalizedDeviceIPHistoryEntry[] {
  if (!entries || entries.length === 0) return [];

  const byKey = new Map<string, NormalizedDeviceIPHistoryEntry>();
  for (const entry of entries) {
    const normalized = normalizeEntry(entry);
    if (!normalized) continue;
    const key = `${normalized.interfaceName}|${normalized.ipAddress}|${normalized.ipType}`;
    byKey.set(key, normalized);
  }
  return Array.from(byKey.values());
}

function parseDetectedAt(value: string | undefined): Date {
  if (!value) return new Date();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    console.warn(`[DeviceIpHistory] invalid detectedAt timestamp: ${value}`);
    return new Date();
  }
  return parsed;
}

function exactKey(entry: Pick<NormalizedDeviceIPHistoryEntry, 'interfaceName' | 'ipAddress' | 'ipType'>): string {
  return `${entry.interfaceName}|${entry.ipAddress}|${entry.ipType}`;
}

function buildOrCondition(conditions: SQL[]): SQL | undefined {
  if (conditions.length === 0) return undefined;
  if (conditions.length === 1) return conditions[0];
  return or(...conditions);
}

export async function processDeviceIPHistoryUpdate(
  deviceId: string,
  orgId: string,
  update: DeviceIPHistoryUpdateInput
): Promise<void> {
  const removedIPs = dedupeEntries(update.removedIPs);
  let changedIPs = dedupeEntries(update.changedIPs);
  const currentIPs = dedupeEntries(update.currentIPs);

  if (removedIPs.length === 0 && changedIPs.length === 0 && currentIPs.length === 0) {
    return;
  }

  const detectedAt = parseDetectedAt(update.detectedAt);

  try {
  await db.transaction(async (tx) => {
    const activeRows = await tx
      .select({
        id: deviceIpHistory.id,
        interfaceName: deviceIpHistory.interfaceName,
        ipAddress: deviceIpHistory.ipAddress,
        ipType: deviceIpHistory.ipType,
      })
      .from(deviceIpHistory)
      .where(
        and(
          eq(deviceIpHistory.deviceId, deviceId),
          eq(deviceIpHistory.isActive, true)
        )
      );

    const activeByExactKey = new Map<string, { id: string; interfaceName: string; ipAddress: string; ipType: string }>();

    for (const row of activeRows) {
      const key = `${row.interfaceName}|${row.ipAddress}|${row.ipType}`;
      activeByExactKey.set(key, row);
    }

    // Bootstrap: if the DB has no active records but the agent reports currentIPs,
    // treat all currentIPs as new so initial records get seeded.
    if (activeByExactKey.size === 0 && currentIPs.length > 0 && changedIPs.length === 0) {
      console.log(`[IPHistory] Bootstrap: seeding ${currentIPs.length} initial IP record(s) for device ${deviceId}`);
      changedIPs = currentIPs;
    }

    const deactivateIds = new Set<string>();

    for (const removed of removedIPs) {
      const existing = activeByExactKey.get(exactKey(removed));
      if (existing) {
        deactivateIds.add(existing.id);
      }
    }

    const existingChanged: Array<{ id: string; entry: NormalizedDeviceIPHistoryEntry }> = [];
    const newChanged: NormalizedDeviceIPHistoryEntry[] = [];

    for (const changed of changedIPs) {
      const existing = activeByExactKey.get(exactKey(changed));
      if (existing) {
        existingChanged.push({ id: existing.id, entry: changed });
        continue;
      }

      newChanged.push(changed);
    }

    if (deactivateIds.size > 0) {
      const ids = Array.from(deactivateIds);
      await tx
        .update(deviceIpHistory)
        .set({
          isActive: false,
          deactivatedAt: detectedAt,
          lastSeen: detectedAt,
          updatedAt: detectedAt,
        })
        .where(
          and(
            eq(deviceIpHistory.deviceId, deviceId),
            inArray(deviceIpHistory.id, ids)
          )
        );
    }

    for (const item of existingChanged) {
      await tx
        .update(deviceIpHistory)
        .set({
          assignmentType: item.entry.assignmentType,
          macAddress: item.entry.macAddress,
          subnetMask: item.entry.subnetMask,
          gateway: item.entry.gateway,
          dnsServers: item.entry.dnsServers,
          lastSeen: detectedAt,
          updatedAt: detectedAt,
        })
        .where(eq(deviceIpHistory.id, item.id));
    }

    if (newChanged.length > 0) {
      await tx.insert(deviceIpHistory).values(
        newChanged.map((entry) => ({
          deviceId,
          orgId,
          interfaceName: entry.interfaceName,
          ipAddress: entry.ipAddress,
          ipType: entry.ipType,
          assignmentType: entry.assignmentType,
          macAddress: entry.macAddress,
          subnetMask: entry.subnetMask,
          gateway: entry.gateway,
          dnsServers: entry.dnsServers,
          firstSeen: detectedAt,
          lastSeen: detectedAt,
          isActive: true,
          updatedAt: detectedAt,
        }))
      );
    }

    const currentConditions: SQL[] = currentIPs.map((current) =>
      and(
        eq(deviceIpHistory.deviceId, deviceId),
        eq(deviceIpHistory.interfaceName, current.interfaceName),
        eq(deviceIpHistory.ipAddress, current.ipAddress),
        eq(deviceIpHistory.ipType, current.ipType),
        eq(deviceIpHistory.isActive, true)
      )!
    );

    const currentWhere = buildOrCondition(currentConditions);
    if (currentWhere) {
      await tx
        .update(deviceIpHistory)
        .set({
          lastSeen: detectedAt,
          updatedAt: detectedAt,
        })
        .where(currentWhere);
    }
  });
  } catch (err) {
    const errorCode = (err as Record<string, unknown>)?.code ?? 'UNKNOWN';
    console.error(
      `[DeviceIpHistory] Transaction failed for device=${deviceId} org=${orgId} ` +
      `(changed=${changedIPs.length} removed=${removedIPs.length} current=${currentIPs.length} dbError=${errorCode})`,
      err
    );
    throw err;
  }
}
