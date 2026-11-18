import { createHash } from 'node:crypto';
import type { EdrDetectionStatus, EdrEndpointHealth, EdrSeverity } from '@breeze/shared';
import { osPlatformFromName, parseVendorDate } from '../normalize';
import type {
  EdrDetectionRef,
  EdrDetectionStatusUpdate,
  VendorEdrDetection,
  VendorEdrEndpoint,
  VendorEdrEndpointDetail,
} from '../types';
import type { EmsiDevice, EmsiDeviceDetails, EmsiIncident, EmsiIncidentDetail } from './client';

/*
 * Emsisoft -> Breeze normalization. Every status / severity / health table is
 * [U] until the owner lab gate (A11) aligns it with the EMC console.
 */

/** Incident-level actions that mean the threat was dealt with. */
export const EMSI_MITIGATING_ACTIONS: ReadonlySet<string> = new Set(['Remediated', 'Deleted', 'Blocked', 'Isolated', 'RollbackCompleted']);
/** Actions that leave the threat in place (or only part-handled). */
export const EMSI_NON_MITIGATING_ACTIONS: ReadonlySet<string> = new Set(['Allowed', 'PartlyRemediated']);
/** `None` / `Reported` also mean "nothing was done": they contradict a mitigating headline action. */
const EMSI_NO_ACTION: ReadonlySet<string> = new Set(['None', 'Reported']);

export const EMSI_SEVERITY: Readonly<Record<string, EdrSeverity>> = {
  Malicious: 'critical',
  LikelyMalicious: 'high',
  Suspicious: 'medium',
  Notable: 'low',
  Unwanted: 'low',
  FalseAlert: 'info',
  None: 'info',
};

export const EMSI_PROTECTION_HEALTH: Readonly<Record<string, EdrEndpointHealth>> = {
  Protected: 'healthy',
  PartiallyProtected: 'degraded',
  RebootRequired: 'degraded',
  Connecting: 'degraded',
  NotProtected: 'unhealthy',
  NotManaged: 'unhealthy',
  NewlyDiscovered: 'unhealthy',
  // Offline / UnusedSeat / anything else: we cannot say -> 'unknown'.
};

const MAX_IPS = 16;
const MAX_DETECTION_ID = 255;

function table<T>(t: Readonly<Record<string, T>>, key: string | null | undefined): T | undefined {
  return key != null && Object.prototype.hasOwnProperty.call(t, key) ? t[key] : undefined;
}

/** Attribution key: trim, strip ONE trailing '.', lower-case. The FULL name -- NOT the first label. '' -> null. */
export function deviceNameKey(name: string | null | undefined): string | null {
  if (typeof name !== 'string') return null;
  let n = name.trim();
  if (n.endsWith('.')) n = n.slice(0, -1);
  n = n.toLowerCase();
  return n.length > 0 ? n : null;
}

/** The trimmed display name with at most one trailing dot removed (casing kept). */
function displayName(name: string | null | undefined): string | null {
  if (typeof name !== 'string') return null;
  let n = name.trim();
  if (n.endsWith('.')) n = n.slice(0, -1);
  return n.length > 0 ? n : null;
}

function firstLabel(name: string): string {
  return name.split('.')[0] ?? name;
}

/**
 * Emsisoft has no closed state, so this NEVER returns `resolved` or `dismissed`.
 * A confirmed-malicious verdict is not a remediation, and an incident-level action does
 * not prove that every involved device was cleaned, so any mixed signal stays `open`.
 */
export function incidentStatus(
  i: Pick<EmsiIncident | EmsiIncidentDetail, 'verdict' | 'actionTaken' | 'actionsTaken'>,
): EdrDetectionStatus {
  switch (i.verdict) {
    case 'ConfirmedBenign':
      return 'false_positive';
    case 'InInvestigation':
      return 'in_progress';
    case 'New':
    case 'ConfirmedMalicious': {
      const all = i.actionsTaken ?? [];
      const contradicted = all.some((a) => EMSI_NON_MITIGATING_ACTIONS.has(a) || EMSI_NO_ACTION.has(a));
      return i.actionTaken != null && EMSI_MITIGATING_ACTIONS.has(i.actionTaken) && !contradicted ? 'mitigated' : 'open';
    }
    default:
      return 'unknown';
  }
}

const vendorStatusOf = (i: Pick<EmsiIncident | EmsiIncidentDetail, 'verdict' | 'actionTaken'>): string =>
  `${i.verdict ?? 'Unknown'}/${i.actionTaken ?? 'None'}`;

/** A device LIST item: identity and name only. Everything else waits for the per-device detail call. */
export function toVendorEndpoint(d: EmsiDevice, vendorTenantId: string): VendorEdrEndpoint {
  const name = displayName(d.name);
  return {
    vendorEndpointId: d.guid,
    vendorTenantId,
    hostname: name ? firstLabel(name) : null,
    fqdn: name && name.includes('.') ? name : null,
    serialNumber: null,
    macAddresses: [],
    ipAddresses: [],
    osPlatform: 'other',
    osName: null,
    endpointType: 'unknown',
    agentVersion: null,
    health: 'unknown',
    online: null,
    isolationState: 'unknown',
    tamperProtection: null,
    policyName: d.protectionPolicyGroup ?? null,
    // [U] `lastUpdate` may be the signature update time, so it stays in `raw` until the lab says otherwise.
    lastSeenAt: null,
    raw: { ...d },
  };
}

/**
 * The per-device detail. `undefined` = "not fetched" (the stored value stays); an explicit
 * `null` = "fetched as empty" (clears it): a device that left its domain must lose its FQDN.
 */
export function toEndpointDetail(vendorEndpointId: string, d: EmsiDeviceDetails): VendorEdrEndpointDetail {
  const out: VendorEdrEndpointDetail = { vendorEndpointId };

  if (d.domain !== undefined) {
    const name = displayName(d.name);
    const domain = typeof d.domain === 'string' ? d.domain.trim() : '';
    // A NetBIOS workgroup such as WORKGROUP has no dot: not a DNS domain.
    out.fqdn = domain.includes('.') && name ? `${firstLabel(name)}.${domain}`.toLowerCase() : null;
  }

  if (d.networkAdapters !== undefined && d.networkAdapters !== null) {
    const v4: string[] = [];
    const v6: string[] = [];
    for (const adapter of d.networkAdapters) {
      v4.push(...(adapter.iPv4Addresses ?? []));
      v6.push(...(adapter.iPv6Addresses ?? []));
    }
    out.ipAddresses = [...new Set([...v4, ...v6].map((a) => a.trim()).filter(Boolean))].slice(0, MAX_IPS);
  }

  if (d.os !== undefined) {
    out.osName = d.os ?? null;
    if (typeof d.os === 'string' && d.os.length > 0) {
      out.osPlatform = osPlatformFromName(d.os);
      out.endpointType = /server/i.test(d.os) ? 'server' : 'workstation';
    }
  }

  if (d.updateStatus !== undefined) {
    const online = d.updateStatus?.online;
    out.online = online === 'Online' ? true : online === 'Offline' ? false : null;
  }
  if (d.protectionStatus !== undefined) out.health = table(EMSI_PROTECTION_HEALTH, d.protectionStatus) ?? 'unknown';
  if (d.version !== undefined) out.agentVersion = d.version ?? null;
  return out;
}

/** Deterministic, collision-safe and NEVER truncated (persist clips at 255). */
export function detectionIdFor(incidentGuid: string, nameKey: string | null): string {
  if (nameKey === null) return incidentGuid;
  const plain = `${incidentGuid}:${nameKey}`;
  if (plain.length <= MAX_DETECTION_ID) return plain;
  return `${incidentGuid}:h:${createHash('sha256').update(nameKey).digest('hex').slice(0, 40)}`;
}

/**
 * One row per distinct involved device. `deviceIndex` is built from the SAME workspace's device
 * list: name key -> device guid, or null when 2+ devices share the key. A name the list does not
 * know stays unattributed. Never guesses, never crosses workspaces.
 */
export function toIncidentDetections(
  i: EmsiIncident,
  vendorTenantId: string,
  deviceIndex: ReadonlyMap<string, string | null>,
): VendorEdrDetection[] {
  const distinct = new Map<string, string>(); // key -> first original string
  for (const raw of i.involvedDevices ?? []) {
    const key = deviceNameKey(raw);
    if (key !== null && !distinct.has(key)) distinct.set(key, (raw as string).trim());
  }
  const targets: Array<{ key: string | null; original: string | null }> = distinct.size > 0
    ? [...distinct].map(([key, original]) => ({ key, original }))
    : [{ key: null, original: null }];

  const status = incidentStatus(i);
  const lastDetectionAt = parseVendorDate(i.lastDetectionAt);
  const closed = status === 'false_positive' || status === 'mitigated';
  const firstFile = i.knownFileNames?.[0] || null;
  const vendorRef = i.sha1 || i.hostAddress || null;

  return targets.map(({ key, original }) => ({
    vendorDetectionId: detectionIdFor(i.guid, key),
    vendorKind: 'incident' as const,
    vendorTenantId,
    vendorEndpointId: key !== null ? (deviceIndex.get(key) ?? null) : null,
    severity: table(EMSI_SEVERITY, i.highestSeverity) ?? 'unknown',
    vendorSeverity: i.highestSeverity ?? null,
    status,
    vendorStatus: vendorStatusOf(i),
    title: firstFile ?? i.hostAddress ?? i.type ?? null,
    category: i.detectionComponent ?? null,
    threatName: null,
    filePath: firstFile,
    processName: null,
    mitreTechniques: [],
    detectedAt: lastDetectionAt,
    resolvedAt: closed ? lastDetectionAt : null,
    lastVendorUpdateAt: lastDetectionAt,
    vendorRef,
    groupKey: i.guid,
    // This row's OWN device string and the involved-device COUNT only: never a sibling's name and
    // never involvedDeviceUsers (D14: site-restricted readers must not learn other devices).
    details: {
      incidentGuid: i.guid,
      type: i.type ?? null,
      verdict: i.verdict ?? null,
      actionTaken: i.actionTaken ?? null,
      actionsTaken: i.actionsTaken ?? [],
      involvedDeviceName: original,
      deviceNameAmbiguous: key !== null && deviceIndex.has(key) && deviceIndex.get(key) === null,
      involvedDeviceCount: distinct.size,
      sha256: i.sha256 ?? null,
      detailsPageLink: i.detailsPageLink ?? null,
    },
  }));
}

/** The vendor's current verdict for a re-read ref, from the incident detail. */
export function toStatusUpdate(ref: EdrDetectionRef, d: EmsiIncidentDetail): EdrDetectionStatusUpdate {
  const status = incidentStatus(d);
  const times = (d.detections ?? [])
    .map((x) => parseVendorDate(x.dateTime))
    .filter((t): t is Date => t !== null)
    .map((t) => t.getTime());
  const lastVendorUpdateAt = times.length > 0 ? new Date(Math.max(...times)) : null;
  return {
    vendorDetectionId: ref.vendorDetectionId,
    vendorKind: ref.vendorKind,
    status,
    vendorStatus: vendorStatusOf(d),
    severity: table(EMSI_SEVERITY, d.severity) ?? 'unknown',
    vendorSeverity: d.severity ?? null,
    resolvedAt: status === 'false_positive' || status === 'mitigated' ? lastVendorUpdateAt : null,
    lastVendorUpdateAt,
  };
}
