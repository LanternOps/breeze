import { and, desc, eq, gte, inArray, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../db';
import {
  alerts,
  alertTemplates,
  discoveredAssetTypeEnum,
  discoveredAssets,
  deviceNetwork,
  devices,
  networkBaselines,
  networkChangeEvents,
  networkEventTypeEnum,
  organizations,
  type KnownNetworkDevice,
  type NetworkBaselineAlertSettings,
  type NetworkBaselineScanSchedule
} from '../db/schema';
import type { DiscoveredHostResult } from '../jobs/discoveryWorker';
import { publishEvent } from './eventBus';

type NetworkEventType = typeof networkEventTypeEnum.enumValues[number];

type EnrichedDiscoveredHost = DiscoveredHostResult & {
  linkedDeviceId?: string | null;
};

interface OrgNetworkPolicy {
  blockedManufacturers: string[];
  allowedAssetTypes: string[];
}

export interface CompareBaselineInput {
  baselineId: string;
  orgId: string;
  siteId: string;
  jobId: string;
  hosts: DiscoveredHostResult[];
}

export interface CompareBaselineResult {
  baselineId: string;
  processedHosts: number;
  newDevices: number;
  disappearedDevices: number;
  changedDevices: number;
  rogueDevices: number;
  eventsCreated: number;
}

const DEFAULT_SCAN_INTERVAL_HOURS = 4;
const MAX_SCAN_INTERVAL_HOURS = 168;
const DISAPPEARED_THRESHOLD_MS = 24 * 60 * 60 * 1000;
const DUPLICATE_EVENT_WINDOW_MS = 24 * 60 * 60 * 1000;

const DEFAULT_ALERT_SETTINGS: NetworkBaselineAlertSettings = {
  newDevice: true,
  disappeared: true,
  changed: true,
  rogueDevice: false
};

const EVENT_ALERT_SETTING: Record<NetworkEventType, keyof NetworkBaselineAlertSettings> = {
  new_device: 'newDevice',
  device_disappeared: 'disappeared',
  device_changed: 'changed',
  rogue_device: 'rogueDevice'
};

const EVENT_TO_TEMPLATE_KEY: Record<NetworkEventType, string> = {
  new_device: 'network.new_device',
  device_disappeared: 'network.device_disappeared',
  device_changed: 'network.device_changed',
  rogue_device: 'network.rogue_device'
};

const EVENT_SEVERITY_FALLBACK: Record<NetworkEventType, typeof alerts.$inferInsert.severity> = {
  new_device: 'medium',
  device_disappeared: 'low',
  device_changed: 'medium',
  rogue_device: 'high'
};

const ASSET_TYPE_SET = new Set(discoveredAssetTypeEnum.enumValues);

function normalizeAssetType(value: string | null | undefined): typeof discoveredAssetTypeEnum.enumValues[number] {
  if (!value) return 'unknown';

  const normalized = value.trim().toLowerCase().replace(/[\s-]/g, '_');
  if (normalized === 'port_scan') return 'unknown';
  if (normalized === 'windows' || normalized === 'linux' || normalized === 'macos') return 'workstation';

  if (ASSET_TYPE_SET.has(normalized as typeof discoveredAssetTypeEnum.enumValues[number])) {
    return normalized as typeof discoveredAssetTypeEnum.enumValues[number];
  }

  return 'unknown';
}

function toDateOrNull(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function toIso(date: Date): string {
  return date.toISOString();
}

function normalizeMac(mac: string | null | undefined): string | null {
  if (!mac) return null;
  const normalized = mac.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function normalizeHostname(hostname: string | null | undefined): string | null {
  if (!hostname) return null;
  const normalized = hostname.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function resolveLinkedDeviceId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseKnownDevices(value: unknown): KnownNetworkDevice[] {
  if (!Array.isArray(value)) return [];

  const parsed: KnownNetworkDevice[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const ip = typeof record.ip === 'string' ? record.ip.trim() : '';
    if (!ip) continue;

    const firstSeenDate = toDateOrNull(typeof record.firstSeen === 'string' ? record.firstSeen : undefined);
    const lastSeenDate = toDateOrNull(typeof record.lastSeen === 'string' ? record.lastSeen : undefined);

    parsed.push({
      ip,
      mac: typeof record.mac === 'string' ? record.mac : null,
      hostname: typeof record.hostname === 'string' ? record.hostname : null,
      assetType: typeof record.assetType === 'string' ? normalizeAssetType(record.assetType) : 'unknown',
      manufacturer: typeof record.manufacturer === 'string' ? record.manufacturer : null,
      linkedDeviceId: resolveLinkedDeviceId(record.linkedDeviceId),
      firstSeen: firstSeenDate ? toIso(firstSeenDate) : toIso(new Date()),
      lastSeen: lastSeenDate ? toIso(lastSeenDate) : toIso(new Date())
    });
  }

  return parsed;
}

export function normalizeBaselineScanSchedule(
  schedule: unknown,
  fallbackIntervalHours = DEFAULT_SCAN_INTERVAL_HOURS
): NetworkBaselineScanSchedule {
  const normalizedFallback = Number.isInteger(fallbackIntervalHours)
    ? Math.min(Math.max(fallbackIntervalHours, 1), MAX_SCAN_INTERVAL_HOURS)
    : DEFAULT_SCAN_INTERVAL_HOURS;

  const record = schedule && typeof schedule === 'object'
    ? (schedule as Record<string, unknown>)
    : {};

  const enabled = typeof record.enabled === 'boolean' ? record.enabled : true;

  const rawInterval = typeof record.intervalHours === 'number'
    ? record.intervalHours
    : Number(record.intervalHours ?? normalizedFallback);
  const intervalHours = Number.isFinite(rawInterval)
    ? Math.min(Math.max(Math.trunc(rawInterval), 1), MAX_SCAN_INTERVAL_HOURS)
    : normalizedFallback;

  const now = new Date();
  const rawNext = typeof record.nextScanAt === 'string' ? record.nextScanAt : undefined;
  const parsedNext = toDateOrNull(rawNext);
  const nextScanAt = parsedNext
    ? toIso(parsedNext)
    : toIso(new Date(now.getTime() + intervalHours * 60 * 60 * 1000));

  return {
    enabled,
    intervalHours,
    nextScanAt
  };
}

export function normalizeBaselineAlertSettings(settings: unknown): NetworkBaselineAlertSettings {
  const record = settings && typeof settings === 'object'
    ? (settings as Record<string, unknown>)
    : {};

  return {
    newDevice: typeof record.newDevice === 'boolean' ? record.newDevice : DEFAULT_ALERT_SETTINGS.newDevice,
    disappeared: typeof record.disappeared === 'boolean' ? record.disappeared : DEFAULT_ALERT_SETTINGS.disappeared,
    changed: typeof record.changed === 'boolean' ? record.changed : DEFAULT_ALERT_SETTINGS.changed,
    rogueDevice: typeof record.rogueDevice === 'boolean' ? record.rogueDevice : DEFAULT_ALERT_SETTINGS.rogueDevice
  };
}

function renderTemplate(template: string, context: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (match, key) => {
    const path = String(key).split('.');
    let value: unknown = context;

    for (const segment of path) {
      if (!value || typeof value !== 'object') {
        return match;
      }
      value = (value as Record<string, unknown>)[segment];
    }

    if (value === null || value === undefined) {
      return match;
    }

    if (typeof value === 'object') {
      return JSON.stringify(value);
    }

    return String(value);
  });
}

function eventEnabled(eventType: NetworkEventType, settings: NetworkBaselineAlertSettings): boolean {
  return settings[EVENT_ALERT_SETTING[eventType]];
}

async function getOrgNetworkPolicy(orgId: string): Promise<OrgNetworkPolicy> {
  const [org] = await db
    .select({ settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  const settings = org?.settings && typeof org.settings === 'object'
    ? (org.settings as Record<string, unknown>)
    : {};

  const nestedNetwork = settings.network && typeof settings.network === 'object'
    ? (settings.network as Record<string, unknown>)
    : {};

  const nestedBaseline = settings.networkBaseline && typeof settings.networkBaseline === 'object'
    ? (settings.networkBaseline as Record<string, unknown>)
    : {};

  const blockedManufacturersRaw = settings.blockedManufacturers
    ?? nestedNetwork.blockedManufacturers
    ?? nestedBaseline.blockedManufacturers;
  const allowedAssetTypesRaw = settings.allowedAssetTypes
    ?? nestedNetwork.allowedAssetTypes
    ?? nestedBaseline.allowedAssetTypes;

  const blockedManufacturers = Array.isArray(blockedManufacturersRaw)
    ? blockedManufacturersRaw.filter((value): value is string => typeof value === 'string').map((value) => value.trim().toLowerCase()).filter(Boolean)
    : [];

  const allowedAssetTypes = Array.isArray(allowedAssetTypesRaw)
    ? allowedAssetTypesRaw
      .filter((value): value is string => typeof value === 'string')
      .map((value) => normalizeAssetType(value))
    : [];

  return { blockedManufacturers, allowedAssetTypes };
}

function isRogueDeviceByPolicy(host: DiscoveredHostResult, policy: OrgNetworkPolicy): boolean {
  const manufacturer = host.manufacturer?.trim().toLowerCase() ?? '';
  const normalizedType = normalizeAssetType(host.assetType);

  if (manufacturer && policy.blockedManufacturers.includes(manufacturer)) {
    return true;
  }

  if (policy.allowedAssetTypes.length > 0 && !policy.allowedAssetTypes.includes(normalizedType)) {
    return true;
  }

  return false;
}

export async function isRogueDevice(host: DiscoveredHostResult, orgId: string): Promise<boolean> {
  const policy = await getOrgNetworkPolicy(orgId);
  return isRogueDeviceByPolicy(host, policy);
}

export function mergeKnownDevices(
  existing: KnownNetworkDevice[],
  scanResults: DiscoveredHostResult[]
): KnownNetworkDevice[] {
  const now = new Date();
  const nowIso = toIso(now);

  const existingByIp = new Map<string, KnownNetworkDevice>();
  for (const device of existing) {
    if (device.ip) {
      existingByIp.set(device.ip, device);
    }
  }

  const merged: KnownNetworkDevice[] = [];

  for (const host of scanResults) {
    if (!host.ip) continue;

    const current = existingByIp.get(host.ip);
    const extendedHost = host as unknown as Record<string, unknown>;

    merged.push({
      ip: host.ip,
      mac: host.mac ?? current?.mac ?? null,
      hostname: host.hostname ?? current?.hostname ?? null,
      assetType: normalizeAssetType(host.assetType ?? current?.assetType ?? 'unknown'),
      manufacturer: host.manufacturer ?? current?.manufacturer ?? null,
      linkedDeviceId: resolveLinkedDeviceId(extendedHost.linkedDeviceId) ?? current?.linkedDeviceId ?? null,
      firstSeen: current?.firstSeen ?? nowIso,
      lastSeen: nowIso
    });

    existingByIp.delete(host.ip);
  }

  for (const remaining of existingByIp.values()) {
    merged.push(remaining);
  }

  return merged;
}

function stringifyKeyState(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim().toLowerCase();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  const normalizeForStableStringify = (input: unknown): unknown => {
    if (Array.isArray(input)) {
      return input.map((entry) => normalizeForStableStringify(entry));
    }

    if (input instanceof Date) {
      return input.toISOString();
    }

    if (input && typeof input === 'object') {
      const record = input as Record<string, unknown>;
      const normalized: Record<string, unknown> = {};
      const sortedKeys = Object.keys(record).sort((left, right) => left.localeCompare(right));
      for (const key of sortedKeys) {
        normalized[key] = normalizeForStableStringify(record[key]);
      }
      return normalized;
    }

    return input;
  };

  try {
    return JSON.stringify(normalizeForStableStringify(value));
  } catch {
    return String(value);
  }
}

function buildEventFingerprint(
  eventType: NetworkEventType,
  ipAddress: string,
  options?: {
    macAddress?: string | null;
    hostname?: string | null;
    assetType?: string | null;
    previousState?: unknown;
    currentState?: unknown;
  }
): string {
  const mac = normalizeMac(options?.macAddress) ?? '';
  const hostname = normalizeHostname(options?.hostname) ?? '';
  const assetType = normalizeAssetType(options?.assetType ?? 'unknown');
  const previous = stringifyKeyState(options?.previousState);
  const current = stringifyKeyState(options?.currentState);

  return `${eventType}:${ipAddress}:${mac}:${hostname}:${assetType}:${previous}:${current}`;
}

function eventTitleFallback(eventType: NetworkEventType, ipAddress: string, hostname?: string | null): string {
  switch (eventType) {
    case 'new_device':
      return `New device detected: ${ipAddress}`;
    case 'device_disappeared':
      return `Device disappeared: ${hostname ?? ipAddress}`;
    case 'device_changed':
      return `Device changed: ${hostname ?? ipAddress}`;
    case 'rogue_device':
      return `Rogue device detected: ${ipAddress}`;
  }
}

function eventMessageFallback(eventType: NetworkEventType, context: Record<string, unknown>): string {
  const hostname = typeof context.hostname === 'string' ? context.hostname : 'unknown';
  const ipAddress = typeof context.ipAddress === 'string' ? context.ipAddress : 'unknown';
  const macAddress = typeof context.macAddress === 'string' ? context.macAddress : 'unknown';

  switch (eventType) {
    case 'new_device':
      return `Discovered a new network device (${hostname}) at ${ipAddress} with MAC ${macAddress}.`;
    case 'device_disappeared':
      return `A known network device (${hostname}) at ${ipAddress} is no longer present in baseline scans.`;
    case 'device_changed':
      return `A known network device (${hostname}) at ${ipAddress} changed characteristics.`;
    case 'rogue_device':
      return `An unauthorized network device (${hostname}) was detected at ${ipAddress}.`;
  }
}

interface AlertDeviceResolution {
  deviceId: string | null;
  shouldPersistLink: boolean;
  strategy:
    | 'event_link'
    | 'discovered_asset_exact_ip'
    | 'device_network_match'
    | 'site_anchor_device'
    | 'org_anchor_device'
    | 'unresolved';
}

async function resolveAlertDeviceForChangeEvent(
  changeEvent: typeof networkChangeEvents.$inferSelect
): Promise<AlertDeviceResolution> {
  if (changeEvent.linkedDeviceId) {
    return {
      deviceId: changeEvent.linkedDeviceId,
      shouldPersistLink: true,
      strategy: 'event_link'
    };
  }

  const [linkedAsset] = await db
    .select({ linkedDeviceId: discoveredAssets.linkedDeviceId })
    .from(discoveredAssets)
    .where(
      and(
        eq(discoveredAssets.orgId, changeEvent.orgId),
        eq(discoveredAssets.ipAddress, changeEvent.ipAddress),
        sql`${discoveredAssets.linkedDeviceId} is not null`
      )
    )
    .limit(1);

  if (linkedAsset?.linkedDeviceId) {
    return {
      deviceId: linkedAsset.linkedDeviceId,
      shouldPersistLink: true,
      strategy: 'discovered_asset_exact_ip'
    };
  }

  const candidateConditions: SQL[] = [];
  if (changeEvent.ipAddress) {
    candidateConditions.push(eq(deviceNetwork.ipAddress, changeEvent.ipAddress));
  }
  if (changeEvent.macAddress) {
    candidateConditions.push(eq(deviceNetwork.macAddress, changeEvent.macAddress));
  }

  if (candidateConditions.length > 0) {
    const [candidate] = await db
      .select({ deviceId: deviceNetwork.deviceId })
      .from(deviceNetwork)
      .innerJoin(devices, eq(devices.id, deviceNetwork.deviceId))
      .where(
        and(
          eq(devices.orgId, changeEvent.orgId),
          eq(devices.siteId, changeEvent.siteId),
          or(...candidateConditions)
        )
      )
      .limit(1);

    if (candidate?.deviceId) {
      return {
        deviceId: candidate.deviceId,
        shouldPersistLink: true,
        strategy: 'device_network_match'
      };
    }
  }

  const [siteAnchorDevice] = await db
    .select({ id: devices.id })
    .from(devices)
    .where(
      and(
        eq(devices.orgId, changeEvent.orgId),
        eq(devices.siteId, changeEvent.siteId)
      )
    )
    .orderBy(desc(devices.lastSeenAt), desc(devices.enrolledAt))
    .limit(1);

  if (siteAnchorDevice?.id) {
    return {
      deviceId: siteAnchorDevice.id,
      shouldPersistLink: false,
      strategy: 'site_anchor_device'
    };
  }

  const [orgAnchorDevice] = await db
    .select({ id: devices.id })
    .from(devices)
    .where(eq(devices.orgId, changeEvent.orgId))
    .orderBy(desc(devices.lastSeenAt), desc(devices.enrolledAt))
    .limit(1);

  if (orgAnchorDevice?.id) {
    return {
      deviceId: orgAnchorDevice.id,
      shouldPersistLink: false,
      strategy: 'org_anchor_device'
    };
  }

  return {
    deviceId: null,
    shouldPersistLink: false,
    strategy: 'unresolved'
  };
}

export async function createNetworkChangeAlert(
  eventType: string,
  changeEvent: typeof networkChangeEvents.$inferSelect,
  baselineSettings: { alertSettings: unknown }
): Promise<void> {
  const normalizedEventType = networkEventTypeEnum.enumValues.find((value) => value === eventType) as NetworkEventType | undefined;
  if (!normalizedEventType) return;

  const alertSettings = normalizeBaselineAlertSettings(baselineSettings.alertSettings);
  if (!eventEnabled(normalizedEventType, alertSettings)) {
    return;
  }

  const alertDeviceResolution = await resolveAlertDeviceForChangeEvent(changeEvent);
  const alertDeviceId = alertDeviceResolution.deviceId;
  if (!alertDeviceId) {
    console.warn(
      `[NetworkBaseline] Skipping alert for event ${changeEvent.id} (${normalizedEventType}) because no managed device mapping or fallback device exists`
    );
    return;
  }

  const templateEventType = EVENT_TO_TEMPLATE_KEY[normalizedEventType];

  const [template] = await db
    .select()
    .from(alertTemplates)
    .where(
      and(
        eq(alertTemplates.isBuiltIn, true),
        sql`${alertTemplates.conditions}->>'eventType' = ${templateEventType}`
      )
    )
    .limit(1);

  const currentState = changeEvent.currentState && typeof changeEvent.currentState === 'object'
    ? (changeEvent.currentState as Record<string, unknown>)
    : {};
  const previousState = changeEvent.previousState && typeof changeEvent.previousState === 'object'
    ? (changeEvent.previousState as Record<string, unknown>)
    : {};

  const context: Record<string, unknown> = {
    eventType: normalizedEventType,
    ipAddress: changeEvent.ipAddress,
    macAddress: changeEvent.macAddress,
    hostname: changeEvent.hostname,
    assetType: changeEvent.assetType,
    manufacturer: currentState.manufacturer,
    detectedAt: toIso(changeEvent.detectedAt),
    previousState,
    currentState
  };
  if (!alertDeviceResolution.shouldPersistLink) {
    context.alertDeviceFallback = true;
    context.alertDeviceResolution = alertDeviceResolution.strategy;
  }

  const title = template
    ? renderTemplate(template.titleTemplate, context)
    : eventTitleFallback(normalizedEventType, changeEvent.ipAddress, changeEvent.hostname);
  const message = template
    ? renderTemplate(template.messageTemplate, context)
    : eventMessageFallback(normalizedEventType, context);
  const severity = template?.severity ?? EVENT_SEVERITY_FALLBACK[normalizedEventType];

  const [alert] = await db
    .insert(alerts)
    .values({
      ruleId: null,
      deviceId: alertDeviceId,
      orgId: changeEvent.orgId,
      severity,
      title,
      message,
      context: {
        source: 'network_baseline',
        networkChangeEventId: changeEvent.id,
        baselineId: changeEvent.baselineId,
        ...context
      },
      status: 'active',
      triggeredAt: changeEvent.detectedAt
    })
    .returning({ id: alerts.id });

  const alertId = alert?.id;
  if (!alertId) {
    return;
  }

  if (alertDeviceResolution.shouldPersistLink) {
    await db
      .update(networkChangeEvents)
      .set({ alertId, linkedDeviceId: alertDeviceId })
      .where(eq(networkChangeEvents.id, changeEvent.id));
  } else {
    await db
      .update(networkChangeEvents)
      .set({ alertId })
      .where(eq(networkChangeEvents.id, changeEvent.id));
  }

  try {
    await publishEvent(
      'alert.triggered',
      changeEvent.orgId,
      {
        alertId,
        ruleId: null,
        deviceId: alertDeviceId,
        severity,
        title,
        message,
        source: 'network-baseline',
        networkChangeEventId: changeEvent.id
      },
      'network-baseline'
    );
  } catch (error) {
    console.error('[NetworkBaseline] Failed to publish alert.triggered event:', error);
  }
}

function hasHostChanged(existing: KnownNetworkDevice, current: EnrichedDiscoveredHost): boolean {
  const existingMac = normalizeMac(existing.mac);
  const currentMac = normalizeMac(current.mac);
  if (existingMac !== currentMac) return true;

  const existingHostname = normalizeHostname(existing.hostname);
  const currentHostname = normalizeHostname(current.hostname);
  if (existingHostname !== currentHostname) return true;

  const existingType = normalizeAssetType(existing.assetType ?? 'unknown');
  const currentType = normalizeAssetType(current.assetType ?? 'unknown');
  if (existingType !== currentType) return true;

  return false;
}

function buildPreviousState(existing: KnownNetworkDevice): Record<string, unknown> {
  return {
    hostname: existing.hostname,
    macAddress: existing.mac,
    assetType: existing.assetType,
    manufacturer: existing.manufacturer,
    lastSeen: existing.lastSeen
  };
}

function buildCurrentState(host: EnrichedDiscoveredHost): Record<string, unknown> {
  return {
    hostname: host.hostname,
    macAddress: host.mac,
    assetType: normalizeAssetType(host.assetType),
    manufacturer: host.manufacturer,
    openPorts: host.openPorts ?? []
  };
}

export async function compareBaselineScan(input: CompareBaselineInput): Promise<CompareBaselineResult> {
  const [baseline] = await db
    .select()
    .from(networkBaselines)
    .where(
      and(
        eq(networkBaselines.id, input.baselineId),
        eq(networkBaselines.orgId, input.orgId),
        eq(networkBaselines.siteId, input.siteId)
      )
    )
    .limit(1);

  if (!baseline) {
    throw new Error(`Baseline ${input.baselineId} not found`);
  }

  const now = new Date();
  const knownDevices = parseKnownDevices(baseline.knownDevices);
  const alertSettings = normalizeBaselineAlertSettings(baseline.alertSettings);

  const scannedHosts = input.hosts.filter((host): host is DiscoveredHostResult => typeof host.ip === 'string' && host.ip.length > 0);
  const scannedIps = Array.from(new Set(scannedHosts.map((host) => host.ip)));

  const discoveredByIp = new Map<string, {
    linkedDeviceId: string | null;
    macAddress: string | null;
    hostname: string | null;
    assetType: typeof discoveredAssetTypeEnum.enumValues[number] | null;
    manufacturer: string | null;
    openPorts: unknown;
  }>();

  if (scannedIps.length > 0) {
    const discoveredRows = await db
      .select({
        ipAddress: discoveredAssets.ipAddress,
        linkedDeviceId: discoveredAssets.linkedDeviceId,
        macAddress: discoveredAssets.macAddress,
        hostname: discoveredAssets.hostname,
        assetType: discoveredAssets.assetType,
        manufacturer: discoveredAssets.manufacturer,
        openPorts: discoveredAssets.openPorts
      })
      .from(discoveredAssets)
      .where(
        and(
          eq(discoveredAssets.orgId, input.orgId),
          inArray(discoveredAssets.ipAddress, scannedIps)
        )
      );

    for (const row of discoveredRows) {
      discoveredByIp.set(row.ipAddress, {
        linkedDeviceId: row.linkedDeviceId,
        macAddress: row.macAddress,
        hostname: row.hostname,
        assetType: row.assetType,
        manufacturer: row.manufacturer,
        openPorts: row.openPorts
      });
    }
  }

  const enrichedHosts: EnrichedDiscoveredHost[] = scannedHosts.map((host) => {
    const discovered = discoveredByIp.get(host.ip);
    return {
      ...host,
      mac: host.mac ?? discovered?.macAddress ?? undefined,
      hostname: host.hostname ?? discovered?.hostname ?? undefined,
      assetType: normalizeAssetType(host.assetType ?? discovered?.assetType ?? 'unknown'),
      manufacturer: host.manufacturer ?? discovered?.manufacturer ?? undefined,
      openPorts: host.openPorts ?? (Array.isArray(discovered?.openPorts)
        ? (discovered?.openPorts as Array<{ port: number; service: string }>)
        : undefined),
      linkedDeviceId: discovered?.linkedDeviceId ?? null
    };
  });

  const knownByIp = new Map<string, KnownNetworkDevice>();
  for (const device of knownDevices) {
    knownByIp.set(device.ip, device);
  }

  const scanByIp = new Map<string, EnrichedDiscoveredHost>();
  for (const host of enrichedHosts) {
    scanByIp.set(host.ip, host);
  }

  const policy = await getOrgNetworkPolicy(input.orgId);

  const recentEvents = await db
    .select({
      eventType: networkChangeEvents.eventType,
      ipAddress: networkChangeEvents.ipAddress,
      macAddress: networkChangeEvents.macAddress,
      hostname: networkChangeEvents.hostname,
      assetType: networkChangeEvents.assetType,
      previousState: networkChangeEvents.previousState,
      currentState: networkChangeEvents.currentState
    })
    .from(networkChangeEvents)
    .where(
      and(
        eq(networkChangeEvents.baselineId, input.baselineId),
        gte(networkChangeEvents.detectedAt, new Date(now.getTime() - DUPLICATE_EVENT_WINDOW_MS))
      )
    )
    .orderBy(desc(networkChangeEvents.detectedAt));

  const eventKeys = new Set<string>(
    recentEvents.map((event) => buildEventFingerprint(event.eventType, event.ipAddress, {
      macAddress: event.macAddress,
      hostname: event.hostname,
      assetType: event.assetType,
      previousState: event.previousState,
      currentState: event.currentState
    }))
  );

  const pendingEvents: Array<typeof networkChangeEvents.$inferInsert> = [];
  let newDevices = 0;
  let disappearedDevices = 0;
  let changedDevices = 0;
  let rogueDevices = 0;

  const tryQueueEvent = (event: typeof networkChangeEvents.$inferInsert): boolean => {
    const key = buildEventFingerprint(event.eventType, event.ipAddress, {
      macAddress: event.macAddress,
      hostname: event.hostname,
      assetType: event.assetType,
      previousState: event.previousState,
      currentState: event.currentState
    });
    if (eventKeys.has(key)) {
      return false;
    }
    eventKeys.add(key);
    pendingEvents.push(event);
    return true;
  };

  for (const host of enrichedHosts) {
    const existing = knownByIp.get(host.ip);
    const currentState = buildCurrentState(host);

    if (!existing) {
      const queued = tryQueueEvent({
        orgId: input.orgId,
        siteId: input.siteId,
        baselineId: input.baselineId,
        eventType: 'new_device',
        ipAddress: host.ip,
        macAddress: host.mac ?? null,
        hostname: host.hostname ?? null,
        assetType: normalizeAssetType(host.assetType),
        currentState,
        linkedDeviceId: host.linkedDeviceId ?? null,
        detectedAt: now
      });

      if (queued) {
        newDevices++;
      }

      if (isRogueDeviceByPolicy(host, policy)) {
        const rogueQueued = tryQueueEvent({
          orgId: input.orgId,
          siteId: input.siteId,
          baselineId: input.baselineId,
          eventType: 'rogue_device',
          ipAddress: host.ip,
          macAddress: host.mac ?? null,
          hostname: host.hostname ?? null,
          assetType: normalizeAssetType(host.assetType),
          currentState,
          linkedDeviceId: host.linkedDeviceId ?? null,
          detectedAt: now
        });

        if (rogueQueued) {
          rogueDevices++;
        }
      }

      continue;
    }

    if (hasHostChanged(existing, host)) {
      const changedQueued = tryQueueEvent({
        orgId: input.orgId,
        siteId: input.siteId,
        baselineId: input.baselineId,
        eventType: 'device_changed',
        ipAddress: host.ip,
        macAddress: host.mac ?? null,
        hostname: host.hostname ?? null,
        assetType: normalizeAssetType(host.assetType),
        previousState: buildPreviousState(existing),
        currentState,
        linkedDeviceId: host.linkedDeviceId ?? existing.linkedDeviceId ?? null,
        detectedAt: now
      });

      if (changedQueued) {
        changedDevices++;
      }
    }
  }

  const disappearedCutoff = new Date(now.getTime() - DISAPPEARED_THRESHOLD_MS);

  for (const known of knownDevices) {
    if (scanByIp.has(known.ip)) continue;

    const lastSeen = toDateOrNull(known.lastSeen);
    if (!lastSeen || lastSeen > disappearedCutoff) continue;

    const disappearedQueued = tryQueueEvent({
      orgId: input.orgId,
      siteId: input.siteId,
      baselineId: input.baselineId,
      eventType: 'device_disappeared',
      ipAddress: known.ip,
      macAddress: known.mac ?? null,
      hostname: known.hostname ?? null,
      assetType: normalizeAssetType(known.assetType ?? 'unknown'),
      previousState: buildPreviousState(known),
      linkedDeviceId: known.linkedDeviceId ?? null,
      detectedAt: now
    });

    if (disappearedQueued) {
      disappearedDevices++;
    }
  }

  const insertedEvents = pendingEvents.length > 0
    ? await db.insert(networkChangeEvents).values(pendingEvents).returning()
    : [];

  if (insertedEvents.length > 0) {
    for (const event of insertedEvents) {
      await createNetworkChangeAlert(event.eventType, event, { alertSettings });
    }
  }

  const mergedKnownDevices = mergeKnownDevices(knownDevices, enrichedHosts);

  await db
    .update(networkBaselines)
    .set({
      knownDevices: mergedKnownDevices,
      lastScanAt: now,
      updatedAt: now,
      scanSchedule: normalizeBaselineScanSchedule(baseline.scanSchedule)
    })
    .where(eq(networkBaselines.id, input.baselineId));

  return {
    baselineId: input.baselineId,
    processedHosts: enrichedHosts.length,
    newDevices,
    disappearedDevices,
    changedDevices,
    rogueDevices,
    eventsCreated: insertedEvents.length
  };
}
