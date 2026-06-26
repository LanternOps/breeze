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

export async function fetchS1Threats(orgId: string, deviceId: string): Promise<S1Threat[]> {
  const params = new URLSearchParams({ orgId, deviceId, limit: '50' });
  const res = await fetchWithAuth(`/s1/threats?${params.toString()}`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const body = await res.json();
  if (!Array.isArray(body?.data)) {
    console.warn('[edr] /s1/threats returned non-array data');
    return [];
  }
  return body.data as S1Threat[];
}

// Huntress returns a flat { data, total, limit, offset } envelope, not S1's { data, pagination } shape.
export async function fetchHuntressIncidents(orgId: string, deviceId: string): Promise<HuntressIncident[]> {
  const params = new URLSearchParams({ orgId, deviceId, limit: '50' });
  const res = await fetchWithAuth(`/huntress/incidents?${params.toString()}`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const body = await res.json();
  if (!Array.isArray(body?.data)) {
    console.warn('[edr] /huntress/incidents returned non-array data');
    return [];
  }
  return body.data as HuntressIncident[];
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
