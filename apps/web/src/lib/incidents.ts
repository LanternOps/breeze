import { fetchWithAuth } from '../stores/auth';
import { runAction } from './runAction';
import type { S1Threat, HuntressIncident } from './edr';

export type IncidentSeverity = 'p1' | 'p2' | 'p3' | 'p4';

export interface CreateIncidentInput {
  orgId: string;
  title: string;
  classification: string;
  severity: IncidentSeverity;
  summary?: string;
  affectedDevices?: string[];
  detectedAt?: string;
}

const SEVERITY_MAP: Record<string, IncidentSeverity> = {
  critical: 'p1',
  high: 'p2',
  medium: 'p3',
  low: 'p4',
};

export function mapEdrSeverity(sev: string | null | undefined): IncidentSeverity {
  return SEVERITY_MAP[(sev ?? '').toLowerCase()] ?? 'p3';
}

function clampTitle(value: string): string {
  return value.length > 500 ? value.slice(0, 500) : value;
}

export function s1ThreatToIncident(t: S1Threat): CreateIncidentInput {
  const device = t.deviceName ?? t.deviceId ?? 'an unknown device';
  return {
    orgId: t.orgId,
    title: clampTitle(`SentinelOne: ${t.threatName ?? 'Unknown threat'}`),
    classification: 'sentinelone-threat',
    severity: mapEdrSeverity(t.severity),
    summary: `Promoted from SentinelOne threat "${t.threatName ?? 'Unknown threat'}" on ${device}.`,
    affectedDevices: t.deviceId ? [t.deviceId] : [],
    detectedAt: t.detectedAt ?? undefined,
  };
}

export function huntressIncidentToIncident(i: HuntressIncident): CreateIncidentInput {
  const device = i.deviceHostname ?? i.deviceId ?? 'an unknown device';
  const body = i.recommendation || i.description || '';
  return {
    orgId: i.orgId,
    title: clampTitle(`Huntress: ${i.title}`),
    classification: 'huntress-incident',
    severity: mapEdrSeverity(i.severity),
    summary: `Promoted from Huntress incident "${i.title}" on ${device}.${body ? ` ${body}` : ''}`.slice(0, 10000),
    affectedDevices: i.deviceId ? [i.deviceId] : [],
    detectedAt: i.reportedAt ?? undefined,
  };
}

export async function promoteToIncident(input: CreateIncidentInput): Promise<{ id: string }> {
  return runAction<{ id: string }>({
    request: () =>
      fetchWithAuth('/incidents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }),
    errorFallback: 'Failed to create incident',
    // No successMessage: the caller navigates to /incidents/{id} on success,
    // and that view transition unmounts the ToastContainer before a toast
    // would render (it would be silently dropped). The navigation is the
    // confirmation.
    parseSuccess: (data) => data as { id: string },
  });
}
