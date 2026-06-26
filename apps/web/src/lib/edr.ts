import { fetchWithAuth } from '../stores/auth';
import { runAction } from './runAction';

export type S1ThreatActionType = 'kill' | 'quarantine' | 'rollback';

export interface S1Threat {
  id: string;
  s1ThreatId: string;
  orgId: string;
  integrationId: string;
  deviceId: string | null;
  deviceName: string | null;
  threatName: string | null;
  classification: string | null;
  severity: string | null;
  status: string;
  processName: string | null;
  filePath: string | null;
  mitreTactics: unknown;
  detectedAt: string | null;
  resolvedAt: string | null;
  updatedAt: string;
  details: unknown;
}

export interface HuntressIncident {
  id: string;
  orgId: string;
  integrationId: string;
  deviceId: string | null;
  deviceHostname: string | null;
  huntressIncidentId: string;
  severity: string | null;
  category: string | null;
  title: string;
  description: string | null;
  recommendation: string | null;
  status: string;
  reportedAt: string | null;
  resolvedAt: string | null;
  details: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface S1ThreatFilters {
  orgId?: string;
  deviceId?: string;
  status?: string;
  severity?: string;
  search?: string;
  start?: string;
  end?: string;
  limit?: number;
  offset?: number;
}

export interface HuntressIncidentFilters {
  orgId?: string;
  deviceId?: string;
  status?: string;
  severity?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

function toParams(filters: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  return params.toString();
}

export async function fetchS1Threats(filters: S1ThreatFilters = {}): Promise<{ rows: S1Threat[]; total: number }> {
  const qs = toParams({ limit: 100, ...filters });
  const res = await fetchWithAuth(`/s1/threats?${qs}`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const body = await res.json();
  if (!Array.isArray(body?.data)) {
    console.warn('[edr] /s1/threats returned non-array data');
    return { rows: [], total: 0 };
  }
  return { rows: body.data as S1Threat[], total: Number(body?.pagination?.total ?? body.data.length) };
}

// Huntress returns a flat { data, total, limit, offset } envelope, not S1's { data, pagination } shape.
export async function fetchHuntressIncidents(
  filters: HuntressIncidentFilters = {},
): Promise<{ rows: HuntressIncident[]; total: number }> {
  const qs = toParams({ limit: 100, ...filters });
  const res = await fetchWithAuth(`/huntress/incidents?${qs}`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const body = await res.json();
  if (!Array.isArray(body?.data)) {
    console.warn('[edr] /huntress/incidents returned non-array data');
    return { rows: [], total: 0 };
  }
  return { rows: body.data as HuntressIncident[], total: Number(body?.total ?? body.data.length) };
}

export async function isolateDevice(orgId: string, deviceId: string, isolate: boolean): Promise<void> {
  await runAction({
    request: () =>
      fetchWithAuth('/s1/isolate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId, deviceIds: [deviceId], isolate }),
      }),
    errorFallback: isolate ? 'Failed to isolate device' : 'Failed to remove isolation',
    successMessage: isolate ? 'Device isolated' : 'Isolation removed',
  });
}

export async function runS1ThreatAction(orgId: string, threatId: string, action: S1ThreatActionType): Promise<void> {
  await runAction({
    request: () =>
      fetchWithAuth('/s1/threat-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId, action, threatIds: [threatId] }),
      }),
    errorFallback: `Failed to ${action} threat`,
    successMessage: `Threat ${action} requested`,
  });
}
