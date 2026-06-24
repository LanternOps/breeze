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
}

export interface VulnerabilityFilters {
  status?: string;
  severity?: string;
  cve?: string;
}

function buildQuery(filters: VulnerabilityFilters): string {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.severity) params.set('severity', filters.severity);
  if (filters.cve) params.set('cve', filters.cve);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

/** Fleet dashboard: CVEs across all accessible devices, aggregated + risk-sorted by the server. */
export async function fetchVulnerabilities(
  filters: VulnerabilityFilters = {},
): Promise<{ items: FleetVulnerability[] }> {
  const res = await fetchWithAuth(`/vulnerabilities${buildQuery(filters)}`);
  if (!res.ok) {
    throw new Error(`Failed to load vulnerabilities (${res.status})`);
  }
  const body = (await res.json()) as { items?: FleetVulnerability[] };
  return { items: body.items ?? [] };
}

/** Per-device findings (one row per CVE on the device) for the device tab. */
export async function fetchDeviceVulnerabilities(
  deviceId: string,
  filters: VulnerabilityFilters = {},
): Promise<{ items: DeviceVulnerabilityItem[] }> {
  const res = await fetchWithAuth(`/vulnerabilities/devices/${deviceId}${buildQuery(filters)}`);
  if (!res.ok) {
    throw new Error(`Failed to load device vulnerabilities (${res.status})`);
  }
  const body = (await res.json()) as { items?: DeviceVulnerabilityItem[] };
  return { items: body.items ?? [] };
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
    successMessage: (d) => `Scheduled ${d.scheduled} remediation${d.scheduled === 1 ? '' : 's'}`,
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
