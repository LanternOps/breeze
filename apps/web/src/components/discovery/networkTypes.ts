import {
  NETWORK_EVENT_TYPES,
  type NetworkEventType,
  type NetworkBaselineScanSchedule,
  type NetworkBaselineAlertSettings
} from '@breeze/shared';

export { NETWORK_EVENT_TYPES };
export type { NetworkEventType, NetworkBaselineScanSchedule, NetworkBaselineAlertSettings };

export type NetworkBaseline = {
  id: string;
  orgId: string;
  siteId: string;
  subnet: string;
  lastScanAt: string | null;
  lastScanJobId: string | null;
  knownDevices: Array<Record<string, unknown>>;
  scanSchedule: NetworkBaselineScanSchedule;
  alertSettings: NetworkBaselineAlertSettings;
  createdAt: string;
  updatedAt: string;
};

export type NetworkChangeEvent = {
  id: string;
  orgId: string;
  siteId: string;
  baselineId: string | null;
  baselineSubnet: string | null;
  profileId: string | null;
  eventType: NetworkEventType;
  ipAddress: string;
  macAddress: string | null;
  hostname: string | null;
  assetType: string | null;
  previousState: Record<string, unknown> | null;
  currentState: Record<string, unknown> | null;
  detectedAt: string;
  acknowledged: boolean;
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
  alertId: string | null;
  linkedDeviceId: string | null;
  notes: string | null;
  createdAt: string;
};

export type DeviceOption = {
  id: string;
  label: string;
};

export const eventTypeConfig: Record<NetworkEventType, { label: string; color: string }> = {
  new_device: { label: 'New Device', color: 'bg-green-500/20 text-green-700 border-green-500/40' },
  device_disappeared: { label: 'Disappeared', color: 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40' },
  device_changed: { label: 'Changed', color: 'bg-blue-500/20 text-blue-700 border-blue-500/40' },
  rogue_device: { label: 'Rogue', color: 'bg-red-500/20 text-red-700 border-red-500/40' }
};

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function asInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseScanSchedule(value: unknown): NetworkBaselineScanSchedule {
  const schedule = asObject(value);
  const interval = asInteger(schedule?.intervalHours);
  return {
    enabled: asBoolean(schedule?.enabled) ?? true,
    intervalHours: interval !== null ? Math.min(Math.max(interval, 1), 168) : 4,
    nextScanAt: asString(schedule?.nextScanAt) ?? new Date().toISOString()
  };
}

function parseAlertSettings(value: unknown): NetworkBaselineAlertSettings {
  const settings = asObject(value);
  return {
    newDevice: asBoolean(settings?.newDevice) ?? true,
    disappeared: asBoolean(settings?.disappeared) ?? true,
    changed: asBoolean(settings?.changed) ?? true,
    rogueDevice: asBoolean(settings?.rogueDevice) ?? false
  };
}

export function mapNetworkBaseline(raw: unknown): NetworkBaseline | null {
  const row = asObject(raw);
  if (!row) return null;

  const id = asString(row.id);
  const orgId = asString(row.orgId);
  const siteId = asString(row.siteId);
  const subnet = asString(row.subnet);
  const createdAt = asString(row.createdAt);
  const updatedAt = asString(row.updatedAt);

  if (!id || !orgId || !siteId || !subnet || !createdAt || !updatedAt) {
    return null;
  }

  return {
    id,
    orgId,
    siteId,
    subnet,
    lastScanAt: asString(row.lastScanAt),
    lastScanJobId: asString(row.lastScanJobId),
    knownDevices: Array.isArray(row.knownDevices)
      ? row.knownDevices.filter((entry): entry is Record<string, unknown> => !!asObject(entry))
      : [],
    scanSchedule: parseScanSchedule(row.scanSchedule),
    alertSettings: parseAlertSettings(row.alertSettings),
    createdAt,
    updatedAt
  };
}

function normalizeEventType(value: unknown): NetworkEventType | null {
  if (typeof value === 'string' && (NETWORK_EVENT_TYPES as readonly string[]).includes(value)) {
    return value as NetworkEventType;
  }
  return null;
}

export function mapNetworkChangeEvent(raw: unknown): NetworkChangeEvent | null {
  const row = asObject(raw);
  if (!row) return null;

  const id = asString(row.id);
  const orgId = asString(row.orgId);
  const siteId = asString(row.siteId);
  const baselineId = asString(row.baselineId);
  const profileId = asString(row.profileId);
  const eventType = normalizeEventType(row.eventType);
  const ipAddress = asString(row.ipAddress);
  const detectedAt = asString(row.detectedAt);
  const createdAt = asString(row.createdAt);
  const acknowledged = asBoolean(row.acknowledged);

  if (!id || !orgId || !siteId || !eventType || !ipAddress || !detectedAt || !createdAt || acknowledged === null) {
    return null;
  }

  return {
    id,
    orgId,
    siteId,
    baselineId,
    baselineSubnet: asString(row.baselineSubnet),
    profileId,
    eventType,
    ipAddress,
    macAddress: asString(row.macAddress),
    hostname: asString(row.hostname),
    assetType: asString(row.assetType),
    previousState: asRecord(row.previousState),
    currentState: asRecord(row.currentState),
    detectedAt,
    acknowledged,
    acknowledgedBy: asString(row.acknowledgedBy),
    acknowledgedAt: asString(row.acknowledgedAt),
    alertId: asString(row.alertId),
    linkedDeviceId: asString(row.linkedDeviceId),
    notes: asString(row.notes),
    createdAt
  };
}

export function formatDateTime(value: string | null | undefined, timezone?: string): string {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString([], timezone ? { timeZone: timezone } : undefined);
}

