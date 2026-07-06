import {
  VULN_SKIP_REASON_LABELS,
  type BulkActionResult,
  type CveCatalogRecord,
  type FleetVulnStats,
  type GroupFinding,
  type RemediateResult,
  type SkippedItem,
  type SoftwareGroup,
  type SoftwareGroupDetail,
  type VulnSeverity,
  type VulnSkipReason,
  type VulnStatus,
  type VulnTicketPriority,
  type VulnTicketResult,
} from '@breeze/shared';

import { fetchWithAuth } from '../../stores/auth';
import { runAction } from '../runAction';

// Re-export the shared fleet-triage domain types so existing web call sites that
// import them from this module keep working (single source of truth is
// @breeze/shared; this module is just the web-side barrel for them).
export type {
  BulkActionResult,
  CveCatalogRecord,
  FleetVulnStats,
  GroupCve,
  GroupFinding,
  RemediateResult,
  SoftwareGroup,
  SoftwareGroupDetail,
  VulnTicketResult,
} from '@breeze/shared';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** A per-(device, CVE) finding row as returned by GET /api/v1/vulnerabilities/devices/:id. */
export interface DeviceVulnerabilityItem {
  id: string; // device_vulnerabilities id
  deviceId: string;
  vulnerabilityId: string;
  cveId: string;
  cvssScore: number | null;
  cvssVector: string | null;
  severity: VulnSeverity | null;
  knownExploited: boolean;
  epssScore: number | null;
  riskScore: number | null;
  status: VulnStatus;
  detectedAt: string;
  patchAvailable: boolean;
}

/** A CVE aggregated across the fleet (one row per CVE, with affected-device count). Server-side aggregated. */
export interface FleetVulnerability {
  id: string; // vulnerabilityId (stable aggregate key)
  cveId: string;
  cvssScore: number | null;
  severity: VulnSeverity | null;
  knownExploited: boolean;
  epssScore: number | null;
  riskScore: number | null;
  deviceCount: number;
  patchAvailable: boolean;
  statuses: VulnStatus[];
}

export interface VulnerabilityFilters {
  status?: string;
  severity?: string;
  cve?: string;
  kevOnly?: boolean;
  patchAvailable?: boolean;
  /** Only findings whose accepted-risk window expires within N days. */
  expiringWithinDays?: number;
}

/** Fleet dashboard: CVEs across all accessible devices, aggregated + risk-sorted by the server. */
export async function fetchVulnerabilities(
  filters: VulnerabilityFilters = {},
): Promise<{ items: FleetVulnerability[]; hasMore: boolean }> {
  const res = await fetchWithAuth(
    `/vulnerabilities${buildVulnQuery({
      status: filters.status,
      severity: filters.severity,
      cve: filters.cve,
      kevOnly: filters.kevOnly,
      patchAvailable: filters.patchAvailable,
      expiringWithinDays: filters.expiringWithinDays,
    })}`,
  );
  if (!res.ok) {
    throw new Error(`Failed to load vulnerabilities (${res.status})`);
  }
  const body = (await res.json()) as { items?: FleetVulnerability[]; hasMore?: boolean };
  return { items: body.items ?? [], hasMore: body.hasMore ?? false };
}

/** Per-device findings (one row per CVE on the device) for the device tab. */
export async function fetchDeviceVulnerabilities(
  deviceId: string,
  filters: VulnerabilityFilters = {},
): Promise<{ items: DeviceVulnerabilityItem[] }> {
  const res = await fetchWithAuth(
    `/vulnerabilities/devices/${deviceId}${buildVulnQuery({
      status: filters.status,
      severity: filters.severity,
      cve: filters.cve,
      kevOnly: filters.kevOnly,
      patchAvailable: filters.patchAvailable,
    })}`,
  );
  if (!res.ok) {
    throw new Error(`Failed to load device vulnerabilities (${res.status})`);
  }
  const body = (await res.json()) as { items?: DeviceVulnerabilityItem[] };
  return { items: body.items ?? [] };
}

// ---- Fleet triage: software groups, stats, CVE detail ----

export interface VulnFleetFilters {
  search: string;
  severity: string; // '' = all
  status: string; // 'open' default
  kevOnly: boolean;
  patchAvailable: boolean;
  /** Only findings whose accepted-risk window expires within N days (set by the
   *  "Accepted, expiring soon" stat card; no visible filter-bar control). */
  expiringWithinDays?: number;
}

/** GET /vulnerabilities/:cveId/devices — the catalog record plus its findings. Web-only wire wrapper. */
export interface CveDevicesPayload {
  cve: CveCatalogRecord;
  findings: GroupFinding[];
}

// ---- Pure helpers (exported for tests) ----

export function buildVulnQuery(params: Record<string, string | number | boolean | undefined>): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '' || value === false) continue;
    q.set(key, String(value));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

/**
 * Summarize a `skipped[]` list as distinct reasons with counts, mapping each
 * `VulnSkipReason` CODE to its human label (`VULN_SKIP_REASON_LABELS`). Unknown
 * codes fall back to the 'unknown' label so a new server code never renders raw.
 * e.g. "10 not found, 8 site access denied".
 */
export function summarizeSkipReasons(skipped: SkippedItem[]): string {
  const counts = new Map<string, number>();
  for (const { reason } of skipped) {
    const label = VULN_SKIP_REASON_LABELS[reason as VulnSkipReason] ?? VULN_SKIP_REASON_LABELS.unknown;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()].map(([label, count]) => `${count} ${label}`).join(', ');
}

export function bulkSummary(verb: string, succeeded: number, skipped: SkippedItem[]): string {
  const base = `${succeeded} ${verb}`;
  if (skipped.length === 0) return base;
  return `${base}, ${skipped.length} skipped — ${summarizeSkipReasons(skipped)}`;
}

// ---- Reads: fleet triage ----

export async function fetchSoftwareGroups(
  filters: VulnFleetFilters,
): Promise<{ items: SoftwareGroup[]; hasMore: boolean }> {
  const res = await fetchWithAuth(
    `/vulnerabilities/software${buildVulnQuery({
      status: filters.status,
      severity: filters.severity,
      search: filters.search,
      kevOnly: filters.kevOnly,
      patchAvailable: filters.patchAvailable,
      expiringWithinDays: filters.expiringWithinDays,
    })}`,
  );
  if (!res.ok) throw new Error('Failed to load software groups');
  return res.json() as Promise<{ items: SoftwareGroup[]; hasMore: boolean }>;
}

export async function fetchSoftwareGroupDetail(groupKey: string): Promise<SoftwareGroupDetail> {
  const res = await fetchWithAuth(`/vulnerabilities/software/${encodeURIComponent(groupKey)}`);
  if (!res.ok) throw new Error('Failed to load software group');
  return res.json() as Promise<SoftwareGroupDetail>;
}

export async function fetchVulnStats(): Promise<FleetVulnStats> {
  const res = await fetchWithAuth('/vulnerabilities/stats');
  if (!res.ok) throw new Error('Failed to load vulnerability stats');
  return res.json() as Promise<FleetVulnStats>;
}

export async function fetchCveDevices(cveId: string): Promise<CveDevicesPayload> {
  const res = await fetchWithAuth(`/vulnerabilities/${encodeURIComponent(cveId)}/devices`);
  if (!res.ok) throw new Error('Failed to load CVE details');
  return res.json() as Promise<CveDevicesPayload>;
}

// ---- Mutations (all wrapped in runAction so every outcome surfaces a toast) ----

export async function remediateVuln(deviceVulnerabilityIds: string[]): Promise<RemediateResult> {
  return runAction<RemediateResult>({
    request: () =>
      fetchWithAuth('/vulnerabilities/remediate', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ deviceVulnerabilityIds }),
      }),
    errorFallback: 'Failed to schedule remediation',
    successMessage: (d) => bulkSummary(`remediation${d.scheduled === 1 ? '' : 's'} scheduled`, d.scheduled, d.skipped),
    parseSuccess: (data) => {
      const d = data as { scheduled?: number; skipped?: SkippedItem[] };
      return { scheduled: d.scheduled ?? 0, skipped: d.skipped ?? [] };
    },
  });
}

export async function acceptVulnRisk(
  id: string,
  body: { reason: string; acceptedUntil: string },
): Promise<void> {
  await runAction({
    request: () =>
      fetchWithAuth(`/vulnerabilities/${id}/accept-risk`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
      }),
    errorFallback: 'Failed to accept risk',
    successMessage: 'Risk accepted',
  });
}

export async function mitigateVuln(id: string, body: { note: string }): Promise<void> {
  await runAction({
    request: () =>
      fetchWithAuth(`/vulnerabilities/${id}/mitigate`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
      }),
    errorFallback: 'Failed to mitigate vulnerability',
    successMessage: 'Marked as mitigated',
  });
}

export async function reopenVuln(id: string): Promise<void> {
  await runAction({
    request: () =>
      fetchWithAuth(`/vulnerabilities/${id}/reopen`, {
        method: 'POST',
      }),
    errorFallback: 'Failed to reopen finding',
    successMessage: 'Finding reopened',
  });
}

// ---- Mutations: bulk fleet actions ----

function parseBulk(data: unknown): BulkActionResult {
  const d = data as Partial<BulkActionResult>;
  return { success: d.success ?? false, succeeded: d.succeeded ?? 0, skipped: d.skipped ?? [] };
}

/** Trailing skip clause for a ticket toast, e.g. ", 18 skipped — 18 access denied". */
function ticketSkipSuffix(skipped: SkippedItem[]): string {
  return skipped.length === 0 ? '' : `, ${skipped.length} skipped — ${summarizeSkipReasons(skipped)}`;
}

export async function bulkAcceptVulnRisk(
  deviceVulnerabilityIds: string[],
  payload: { reason: string; acceptedUntil: string },
): Promise<BulkActionResult> {
  return runAction<BulkActionResult>({
    request: () =>
      fetchWithAuth('/vulnerabilities/bulk/accept-risk', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ deviceVulnerabilityIds, ...payload }),
      }),
    errorFallback: 'Failed to accept risk',
    successMessage: (d) => bulkSummary('accepted', d.succeeded, d.skipped),
    parseSuccess: parseBulk,
  });
}

export async function bulkMitigateVulns(
  deviceVulnerabilityIds: string[],
  payload: { note: string },
): Promise<BulkActionResult> {
  return runAction<BulkActionResult>({
    request: () =>
      fetchWithAuth('/vulnerabilities/bulk/mitigate', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ deviceVulnerabilityIds, ...payload }),
      }),
    errorFallback: 'Failed to mitigate',
    successMessage: (d) => bulkSummary('mitigated', d.succeeded, d.skipped),
    parseSuccess: parseBulk,
  });
}

export async function createVulnTicket(
  deviceVulnerabilityIds: string[],
  payload: { title: string; priority: VulnTicketPriority; note?: string },
): Promise<VulnTicketResult> {
  return runAction<VulnTicketResult>({
    request: () =>
      fetchWithAuth('/vulnerabilities/tickets', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ deviceVulnerabilityIds, ...payload }),
      }),
    errorFallback: 'Failed to create ticket',
    // The server builds each org's device/CVE description itself, one ticket per
    // org. Surface both the created count AND any per-org skips (SF#1) so a
    // partial success (e.g. access denied on some orgs) is never silent. When
    // ALL orgs are skipped the server returns success:false and runAction
    // surfaces its message instead — this only runs on success.
    successMessage: (d) => {
      const base = d.tickets.length === 1 ? 'Ticket created' : `${d.tickets.length} tickets created (one per organization)`;
      return `${base}${ticketSkipSuffix(d.skipped)}`;
    },
    parseSuccess: (data) => {
      const d = data as Partial<VulnTicketResult>;
      return { success: d.success ?? false, tickets: d.tickets ?? [], skipped: d.skipped ?? [] };
    },
  });
}
