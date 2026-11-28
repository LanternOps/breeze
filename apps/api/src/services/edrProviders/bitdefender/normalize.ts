import type { EdrDetectionStatus, EdrSeverity } from '@breeze/shared';
import { bucketStatus, normalizeMacs, osPlatformFromName } from '../normalize';
import type { VendorEdrDetection, VendorEdrEndpoint, VendorEdrEndpointDetail } from '../types';
import type { GzEndpointDetails, GzIncident, GzInventoryItem, GzQuarantineItem } from './client';
import { lacksOffset, parseGzDate } from './time';

/**
 * The account timezone as the normalizers use it (#12821):
 * - a zone name: an offset-less time is read in it;
 * - `null`: unavailable for a lasting reason: an offset-less time is stored as null;
 * - `ZONE_NOT_READ`: the read failed this run: an offset-less time is left undefined, so a stored
 *   value is kept and a new row starts with none.
 * A time that carries its own offset is read the same way in all three cases. Never a guess.
 */
export const ZONE_NOT_READ: unique symbol = Symbol('gz-zone-not-read');
export type GzZone = string | null | typeof ZONE_NOT_READ;

function gzTime(raw: unknown, zone: GzZone): Date | null | undefined {
  if (zone === ZONE_NOT_READ) return lacksOffset(raw) ? undefined : parseGzDate(raw, null);
  return parseGzDate(raw, zone);
}

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

/**
 * Quarantine item `actionStatus` (computers service), an Integer per the vendor's
 * getQuarantineItemsList reference: 0 None, 1 Pending remove, 2 Pending restore, 3 Remove failed,
 * 4 Restore failed (16 and 17 are the Exchange service only). Live items carry the number
 * (`actionStatus: 0`, 2026-11-27, #12825). Every documented code is a file still held in quarantine
 * (a pending or failed remove or restore has not taken it out), so each is `mitigated`; the code is
 * kept as `vendorStatus`. Keys are strings because the lookup is by `String(value)`, so `0` and `"0"`
 * both match. Anything else is `unknown` (the adapter logs the code).
 */
export const GZ_QUARANTINE_STATUS: Readonly<Record<string, EdrDetectionStatus>> = {
  '0': 'mitigated',
  '1': 'mitigated',
  '2': 'mitigated',
  '3': 'mitigated',
  '4': 'mitigated',
};

/** True when `actionStatus` is one of the documented codes above. */
export function isDocumentedQuarantineStatus(value: unknown): boolean {
  return (typeof value === 'number' || typeof value === 'string')
    && Object.prototype.hasOwnProperty.call(GZ_QUARANTINE_STATUS, String(value));
}

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

/**
 * `zone` is the API key owner's account timezone (see GzZone). `lastSeen` has no offset: it is
 * null when the zone is unavailable, and absent (the stored value stays) when it was not read (#12821).
 */
export function toEndpointDetail(id: string, d: GzEndpointDetails, zone: GzZone): VendorEdrEndpointDetail {
  const agent = d.agent ?? {};
  let health: VendorEdrEndpointDetail['health'] = 'healthy';
  if (d.malwareStatus?.infected) health = 'unhealthy';
  else if (agent.signatureOutdated || agent.productOutdated || agent.licensed === false) health = 'degraded';
  const lastSeenAt = gzTime(d.lastSeen, zone);
  return {
    vendorEndpointId: id,
    health,
    online: onlineFromState(d.state),
    ...(lastSeenAt === undefined ? {} : { lastSeenAt }),
    agentVersion: agent.productVersion ?? null,
    osName: d.operatingSystem ?? undefined,
  };
}

const TERMINAL: readonly EdrDetectionStatus[] = ['resolved', 'false_positive', 'dismissed'];

/** Incident times carry an explicit offset (live 2026-11-27); `zone` only reads one that does not. */
export function toIncidentDetection(item: GzIncident, vendorTenantId: string, zone: GzZone): VendorEdrDetection {
  const status = bucketStatus(GZ_INCIDENT_STATUS, item.status as string | number | null | undefined);
  const lastChange = gzTime(item.lastIncidentChange, zone);
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
    detectedAt: gzTime(item.created, zone),
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

/** `quarantinedOn` has no offset: read in `zone`; null when it is unavailable, undefined when not read (#12821). */
export function toQuarantineDetection(item: GzQuarantineItem, vendorTenantId: string, zone: GzZone): VendorEdrDetection {
  const quarantinedOn = gzTime(item.quarantinedOn, zone);
  const status = isDocumentedQuarantineStatus(item.actionStatus)
    ? bucketStatus(GZ_QUARANTINE_STATUS, item.actionStatus)
    : 'unknown';
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
