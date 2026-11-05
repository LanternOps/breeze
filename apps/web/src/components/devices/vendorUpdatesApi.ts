import type { OemCategory, OemLane, OemOutcome } from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';

/** GET /devices/:id/oem-updates/status (apps/api/src/routes/devices/oemUpdates.ts). */
export type OemDisplayState =
  | 'up_to_date'
  | 'overdue'
  | 'failing'
  | 'not_supported'
  | 'not_managed'
  | 'waiting_for_reboot'
  | 'reboot_overdue';

export type OemLastRun = {
  lane: OemLane | null;
  toolVersion: string | null;
  lastOutcome: OemOutcome | null;
  lastErrorCode: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  installedCount: number;
  failedCount: number;
  rebootRequired: boolean;
  rebootPendingSince: string | null;
  biosVersionBefore: string | null;
  biosVersionAfter: string | null;
};

export type OemStatusView = {
  displayState: OemDisplayState;
  /** Null when no run could reach this device, including with the feature off. */
  lane: OemLane | null;
  status: OemLastRun | null;
  gates: Record<OemCategory, 'open' | 'closed'>;
};

export type OemRunItem = {
  title: string;
  category: OemCategory;
  version: string;
  result: 'installed' | 'failed' | 'skipped';
};

/** GET /devices/:id/oem-updates/history. */
export type OemRunView = {
  commandId: string;
  trigger: 'scheduled' | 'on_demand' | null;
  status: string;
  outcome: OemOutcome | null;
  errorCode: string | null;
  toolVersion: string | null;
  items: OemRunItem[];
  createdAt: string;
  completedAt: string | null;
  actor: { id: string; name: string | null; email: string | null } | null;
};

export type OemStatusRead =
  | { kind: 'ok'; view: OemStatusView }
  /** Refused, or not this feature's shape: nothing to show and nothing to report. */
  | { kind: 'hidden' }
  | { kind: 'error' };

function isStatusView(value: unknown): value is OemStatusView {
  if (!value || typeof value !== 'object') return false;
  const { displayState, lane, gates } = value as Record<string, unknown>;
  return typeof displayState === 'string'
    && (lane === null || typeof lane === 'string')
    && Boolean(gates) && typeof gates === 'object';
}

export async function readOemStatus(deviceId: string): Promise<OemStatusRead> {
  let response: Response;
  try {
    response = await fetchWithAuth(`/devices/${deviceId}/oem-updates/status`);
  } catch {
    return { kind: 'error' };
  }
  if (!response) return { kind: 'error' };
  if (response.status === 403 || response.status === 404) return { kind: 'hidden' };
  if (!response.ok) return { kind: 'error' };
  const body: unknown = await response.json().catch(() => null);
  return isStatusView(body) ? { kind: 'ok', view: body } : { kind: 'hidden' };
}

/** Product names, not translated (locales/TERMINOLOGY.md). */
export const OEM_VENDOR_NAMES: Record<OemLane, string> = {
  dell: 'Dell',
  surface: 'Microsoft Surface',
  hp: 'HP',
  lenovo: 'Lenovo',
};
