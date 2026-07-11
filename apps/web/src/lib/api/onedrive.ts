// apps/web/src/lib/api/onedrive.ts
import { fetchWithAuth } from '../../stores/auth';

export type OneDriveLibrary = {
  siteId: string;
  siteName: string;
  siteUrl: string;
  driveId: string;
  listId: string;
  libraryName: string;
  tenantId: string;
  webId: string;
  spSiteId: string;
  autoMountValue: string;
};

export type OneDriveDeviceState = {
  deviceId: string;
  signedIn: boolean;
  oneDriveVersion: string | null;
  filesOnDemandOn: boolean;
  kfmFolderStates: Record<string, string>;
  mountedLibraries: string[];
  entitledLibraries: string[];
  driftEntries: Array<{ libraryId: string; displayName: string; reason: string }>;
  lastReportedAt: string;
};

export type OneDriveFleetRow = OneDriveDeviceState & { hostname: string };

export type OneDriveFleetStats = { total: number; signedIn: number; kfmProtected: number; withDrift: number };

function orgQuery(orgId?: string): string {
  return orgId ? `?orgId=${encodeURIComponent(orgId)}` : '';
}

/** Extract a server-provided error message, falling back to statusText. */
async function extractError(res: Response): Promise<string> {
  const json = await res.json().catch(() => ({}));
  const errorText = (json as Record<string, unknown>).error;
  return typeof errorText === 'string' && errorText ? errorText : res.statusText;
}

export async function fetchM365ConnectionStatus(orgId?: string): Promise<boolean> {
  const res = await fetchWithAuth(`/m365/connection${orgQuery(orgId)}`);
  // A non-ok response (including the 404 the server returns for the whole
  // m365Routes group when the M365 integration feature-flag is off) simply
  // means "cannot browse via Graph right now" — treat it as disconnected
  // rather than throwing, so the UI falls back to manual library-ID paste
  // instead of showing an error state with no way forward.
  if (!res.ok) return false;
  const data = (await res.json()) as { connected?: unknown };
  return data.connected === true;
}

export async function fetchOneDriveLibraries(
  orgId?: string,
): Promise<{ libraries: OneDriveLibrary[]; skippedSites: Array<{ siteId: string; code: string }> }> {
  const res = await fetchWithAuth(`/onedrive/libraries${orgQuery(orgId)}`);
  if (!res.ok) throw new Error(await extractError(res));
  const data = (await res.json()) as {
    libraries?: OneDriveLibrary[];
    skippedSites?: Array<{ siteId: string; code: string }>;
  };
  return { libraries: data.libraries ?? [], skippedSites: data.skippedSites ?? [] };
}

export async function fetchDeviceOneDriveState(deviceId: string): Promise<OneDriveDeviceState | null> {
  const res = await fetchWithAuth(`/onedrive/devices/${encodeURIComponent(deviceId)}/state`);
  if (!res.ok) throw new Error(await extractError(res));
  const data = (await res.json()) as { state?: OneDriveDeviceState | null };
  return data.state ?? null;
}

export async function fetchOneDriveFleetState(
  orgId?: string,
): Promise<{ devices: OneDriveFleetRow[]; stats: OneDriveFleetStats }> {
  const res = await fetchWithAuth(`/onedrive/state${orgQuery(orgId)}`);
  if (!res.ok) throw new Error(await extractError(res));
  const data = (await res.json()) as { devices?: OneDriveFleetRow[]; stats?: OneDriveFleetStats };
  return {
    devices: data.devices ?? [],
    stats: data.stats ?? { total: 0, signedIn: 0, kfmProtected: 0, withDrift: 0 },
  };
}
