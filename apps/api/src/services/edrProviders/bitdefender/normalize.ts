import type { EdrDetectionStatus, EdrSeverity } from '@breeze/shared';
import { bucketStatus, normalizeMacs, osPlatformFromName, parseVendorDate } from '../normalize';
import type { VendorEdrDetection, VendorEdrEndpoint, VendorEdrEndpointDetail } from '../types';
import type { GzEndpointDetails, GzIncident, GzInventoryItem, GzQuarantineItem } from './client';

/**
 * Incident `status` codes. [U] The numeric set is unconfirmed against a licensed console; unknown
 * values bucket to `unknown` (never throw). Align during the sandbox gate.
 */
export const GZ_INCIDENT_STATUS: Readonly<Record<string, EdrDetectionStatus>> = {
  '1': 'open',
  '2': 'in_progress',
  '3': 'resolved',
  '4': 'false_positive',
  open: 'open',
  investigating: 'in_progress',
  in_progress: 'in_progress',
  closed: 'resolved',
  resolved: 'resolved',
  false_positive: 'false_positive',
};

/** Quarantine item `actionStatus`. [U] value set; unknown -> `unknown`. */
export const GZ_QUARANTINE_STATUS: Readonly<Record<string, EdrDetectionStatus>> = {
  quarantined: 'mitigated',
  restored: 'dismissed',
  removed: 'resolved',
};

/** [U] align with the console's own severity buckets during the sandbox gate. */
export function bucketSeverityScore(score: unknown): EdrSeverity {
  const n = typeof score === 'number' ? score : typeof score === 'string' && score.trim() !== '' ? Number(score) : NaN;
  if (!Number.isFinite(n)) return 'unknown';
  if (n >= 90) return 'critical';
  if (n >= 70) return 'high';
  if (n >= 40) return 'medium';
  if (n >= 1) return 'low';
  return 'unknown';
}

const asString = (v: unknown): string | null =>
  v === null || v === undefined || v === '' ? null : String(v);

/** Short host name: the part of `name` before the first dot. */
function shortHostname(name: string | undefined): string | null {
  const n = (name ?? '').trim();
  if (!n) return null;
  return n.split('.')[0] || null;
}

export function toVendorEndpoint(item: GzInventoryItem, vendorTenantId: string): VendorEdrEndpoint {
  const d = item.details ?? {};
  const osName = d.operatingSystemVersion?.trim() || null;
  const isServer = /server/i.test(osName ?? '');
  const ip = typeof d.ip === 'string' && d.ip.trim() ? [d.ip.trim()] : [];
  return {
    vendorEndpointId: String(item.id),
    vendorTenantId,
    hostname: shortHostname(item.name),
    fqdn: d.fqdn?.trim() || null,
    serialNumber: null,
    macAddresses: normalizeMacs(d.macs),
    ipAddresses: ip,
    osPlatform: osPlatformFromName(osName),
    osName,
    // machineType: 1 physical, 2 virtual, 3 EC2 (per docs); Server in the OS name wins.
    endpointType: isServer ? 'server' : 'workstation',
    agentVersion: null,
    health: d.productOutdated ? 'degraded' : 'unknown',
    online: null,
    isolationState: d.isIsolated === undefined || d.isIsolated === null ? 'unknown' : d.isIsolated ? 'isolated' : 'not_isolated',
    tamperProtection: null,
    policyName: d.policy?.name ?? null,
    lastSeenAt: null,
    raw: item as unknown as Record<string, unknown>,
  };
}

/** `state` -> online. [U] 1 online / 2 offline per the docs; anything else is unknown (null). */
function onlineFromState(state: unknown): boolean | null {
  const s = String(state ?? '');
  if (s === '1') return true;
  if (s === '2') return false;
  return null;
}

export function toEndpointDetail(id: string, d: GzEndpointDetails): VendorEdrEndpointDetail {
  const agent = d.agent ?? {};
  let health: VendorEdrEndpointDetail['health'] = 'healthy';
  if (d.malwareStatus?.infected) health = 'unhealthy';
  else if (agent.signatureOutdated || agent.productOutdated || agent.licensed === false) health = 'degraded';
  return {
    vendorEndpointId: id,
    health,
    online: onlineFromState(d.state),
    lastSeenAt: parseVendorDate(d.lastSeen),
    agentVersion: agent.productVersion ?? null,
    osName: d.operatingSystem ?? undefined,
  };
}

const TERMINAL: readonly EdrDetectionStatus[] = ['resolved', 'false_positive', 'dismissed'];

export function toIncidentDetection(item: GzIncident, vendorTenantId: string): VendorEdrDetection {
  const status = bucketStatus(GZ_INCIDENT_STATUS, item.status as string | number | null | undefined);
  const lastChange = parseVendorDate(item.lastIncidentChange);
  return {
    vendorDetectionId: String(item.incidentId),
    vendorKind: 'incident',
    vendorTenantId,
    vendorEndpointId: asString(item.details?.computerId),
    severity: bucketSeverityScore(item.severityScore),
    vendorSeverity: asString(item.severityScore),
    status,
    vendorStatus: asString(item.status),
    title: asString(item.details?.detectionName) ?? `Incident #${item.incidentNumber ?? item.incidentId}`,
    category: null,
    threatName: asString(item.details?.detectionName),
    filePath: null,
    processName: null,
    mitreTechniques: [],
    detectedAt: parseVendorDate(item.created),
    resolvedAt: TERMINAL.includes(status) ? lastChange : null,
    lastVendorUpdateAt: lastChange,
    details: {
      incidentNumber: item.incidentNumber ?? null,
      mainAction: item.mainAction ?? null,
      priority: item.priority ?? null,
      attackTypes: item.attackTypes ?? [],
      incidentLink: item.incidentLink ?? null,
    },
  };
}

export function toQuarantineDetection(item: GzQuarantineItem, vendorTenantId: string): VendorEdrDetection {
  const quarantinedOn = parseVendorDate(item.quarantinedOn);
  const status = bucketStatus(
    GZ_QUARANTINE_STATUS,
    typeof item.actionStatus === 'string' ? item.actionStatus.toLowerCase() : item.actionStatus,
  );
  return {
    vendorDetectionId: String(item.id),
    vendorKind: 'quarantine_item',
    vendorTenantId,
    vendorEndpointId: asString(item.endpointId),
    // A quarantined file is a contained threat. [U] revisit with the sandbox.
    severity: 'medium',
    vendorSeverity: null,
    status,
    vendorStatus: asString(item.actionStatus),
    title: asString(item.threatName),
    category: null,
    threatName: asString(item.threatName),
    filePath: asString(item.details?.filePath),
    processName: null,
    mitreTechniques: [],
    detectedAt: quarantinedOn,
    resolvedAt: null,
    lastVendorUpdateAt: quarantinedOn,
    details: {
      fileSha256: item.details?.fileSha256 ?? null,
      canBeRestored: item.canBeRestored ?? null,
      canBeRemoved: item.canBeRemoved ?? null,
    },
  };
}
