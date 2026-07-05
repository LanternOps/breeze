import { fetchWithAuth } from '../../stores/auth';
import { runAction } from '../runAction';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** A per-(device, CVE) finding row as returned by GET /api/v1/vulnerabilities/devices/:id. */
export interface DeviceVulnerabilityItem {
  id: string; // device_vulnerabilities id
  deviceId: string;
  vulnerabilityId: string;
  cveId: string;
  cvssScore: number | null;
  cvssVector: string | null;
  severity: string | null;
  knownExploited: boolean;
  epssScore: number | null;
  riskScore: number | null;
  status: string;
  detectedAt: string;
  patchAvailable: boolean;
}

/** A CVE aggregated across the fleet (one row per CVE, with affected-device count). Server-side aggregated. */
export interface FleetVulnerability {
  id: string; // vulnerabilityId (stable aggregate key)
  cveId: string;
  cvssScore: number | null;
  severity: string | null;
  knownExploited: boolean;
  epssScore: number | null;
  riskScore: number | null;
  deviceCount: number;
  patchAvailable: boolean;
  statuses: string[];
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

export interface SoftwareGroup {
  groupKey: string;
  kind: 'software' | 'os';
  name: string;
  vendor: string | null;
  versions: string[];
  deviceCount: number;
  cveCount: number;
  cveIds: string[];
  worstSeverity: string | null;
  maxRiskScore: number | null;
  kevCveCount: number;
  maxEpss: number | null;
  patchReadyFindingCount: number;
  patchReadyDeviceCount: number;
  /** Distinct linked tickets; `number` is the human ticket number (null for legacy tickets). */
  tickets: Array<{ id: string; number: string | null }>;
}

export interface GroupCve {
  cveId: string;
  vulnerabilityId: string;
  severity: string | null;
  cvssScore: number | null;
  epssScore: number | null;
  knownExploited: boolean;
  patchAvailable: boolean;
  maxRiskScore: number | null;
}

export interface GroupFinding {
  deviceVulnerabilityId: string;
  deviceId: string;
  deviceName: string;
  orgId: string;
  orgName: string | null;
  cveId: string;
  status: string;
  patchAvailable: boolean;
  riskScore: number | null;
  detectedAt: string;
  /** ISO expiry of an accepted-risk window; null unless status is 'accepted'. */
  acceptedUntil: string | null;
  ticketId: string | null;
  ticketNumber: string | null;
}

export interface SoftwareGroupDetail {
  group: SoftwareGroup;
  cves: GroupCve[];
  findings: GroupFinding[];
}

export interface FleetVulnStats {
  criticalOpen: number;
  kevCveCount: number;
  kevDeviceCount: number;
  patchReadyFindingCount: number;
  acceptedExpiringSoon: number;
  /** Findings across ALL statuses — "has scanning ever produced data". Feeds
   *  the clean-fleet vs never-scanned empty-state split. */
  totalFindings: number;
  /** Most recent detectedAt across all findings (ISO), null when none exist. */
  lastDetectedAt: string | null;
}

export interface CveCatalogRecord {
  cveId: string;
  description: string;
  references: unknown;
  cvssVersion: string | null;
  cvssVector: string | null;
  cvssScore: number | null;
  epssScore: number | null;
  knownExploited: boolean;
  patchAvailable: boolean;
  severity: string | null;
  publishedAt: string | null;
  modifiedAt: string | null;
}

export interface CveDevicesPayload {
  cve: CveCatalogRecord;
  findings: GroupFinding[];
}

export interface BulkActionResult {
  success: boolean;
  succeeded: number;
  skipped: Array<{ id: string; reason: string }>;
}

export interface VulnTicketResult {
  success: boolean;
  tickets: Array<{ ticketId: string; orgId: string; findingCount: number }>;
  skipped: Array<{ id: string; reason: string }>;
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

export function bulkSummary(verb: string, succeeded: number, skipped: Array<{ id: string; reason: string }>): string {
  const base = `${succeeded} ${verb}`;
  if (skipped.length === 0) return base;
  return `${base}, ${skipped.length} skipped — ${skipped[0]!.reason}`;
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

export interface RemediateResult {
  scheduled: number;
  skipped: Array<{ id: string; reason: string }>;
}

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
      const d = data as { scheduled?: number; skipped?: Array<{ id: string; reason: string }> };
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
  payload: { title: string; description?: string; priority: 'low' | 'normal' | 'high' | 'urgent' },
): Promise<VulnTicketResult> {
  return runAction<VulnTicketResult>({
    request: () =>
      fetchWithAuth('/vulnerabilities/tickets', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ deviceVulnerabilityIds, ...payload }),
      }),
    errorFallback: 'Failed to create ticket',
    successMessage: (d) =>
      d.tickets.length === 1 ? 'Ticket created' : `${d.tickets.length} tickets created (one per organization)`,
    parseSuccess: (data) => {
      const d = data as Partial<VulnTicketResult>;
      return { success: d.success ?? false, tickets: d.tickets ?? [], skipped: d.skipped ?? [] };
    },
  });
}
