import { fetchWithAuth } from '../../stores/auth';

/** A per-(device, CVE) finding row as returned by GET /api/v1/vulnerabilities. */
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
}

/** A CVE aggregated across the fleet (one row per CVE, with affected-device count). */
export interface FleetVulnerability {
  id: string; // vulnerabilityId (stable aggregate key)
  cveId: string;
  cvssScore: number | null;
  severity: string | null;
  knownExploited: boolean;
  epssScore: number | null;
  riskScore: number | null;
  status: string;
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

function descNullsLast(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

/**
 * Collapse per-device findings into one row per CVE with an affected-device count.
 * The risk fields (cvss/kev/epss/risk) are CVE-constant, so we take them from any
 * row. Sort matches the spec: riskScore, then KEV, then EPSS, then CVSS (all desc,
 * nulls last) — riskScore already folds in KEV/EPSS, the rest break ties.
 */
export function aggregateByVulnerability(items: DeviceVulnerabilityItem[]): FleetVulnerability[] {
  const byVuln = new Map<string, FleetVulnerability>();
  for (const item of items) {
    const existing = byVuln.get(item.vulnerabilityId);
    if (existing) {
      existing.deviceCount += 1;
      // Keep the highest risk/cvss seen (they should be equal per CVE, but be safe).
      if ((item.riskScore ?? -1) > (existing.riskScore ?? -1)) existing.riskScore = item.riskScore;
      continue;
    }
    byVuln.set(item.vulnerabilityId, {
      id: item.vulnerabilityId,
      cveId: item.cveId,
      cvssScore: item.cvssScore,
      severity: item.severity,
      knownExploited: item.knownExploited,
      epssScore: item.epssScore,
      riskScore: item.riskScore,
      status: item.status,
      deviceCount: 1,
    });
  }

  return [...byVuln.values()].sort((a, b) => {
    const byRisk = descNullsLast(a.riskScore, b.riskScore);
    if (byRisk !== 0) return byRisk;
    if (a.knownExploited !== b.knownExploited) return a.knownExploited ? -1 : 1;
    const byEpss = descNullsLast(a.epssScore, b.epssScore);
    if (byEpss !== 0) return byEpss;
    return descNullsLast(a.cvssScore, b.cvssScore);
  });
}

/** Fleet dashboard: CVEs across all accessible devices, aggregated + risk-sorted. */
export async function fetchVulnerabilities(
  filters: VulnerabilityFilters = {},
): Promise<{ items: FleetVulnerability[] }> {
  const res = await fetchWithAuth(`/vulnerabilities${buildQuery(filters)}`);
  if (!res.ok) {
    throw new Error(`Failed to load vulnerabilities (${res.status})`);
  }
  const body = (await res.json()) as { items?: DeviceVulnerabilityItem[] };
  return { items: aggregateByVulnerability(body.items ?? []) };
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
