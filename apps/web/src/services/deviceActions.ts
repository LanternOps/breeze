import { fetchWithAuth } from '@/stores/auth';

export interface CommandResult {
  id: string;
  deviceId: string;
  type: string;
  status: string;
  createdAt: string;
}

export interface BulkCommandResponse {
  commands: CommandResult[];
  failed: string[];
}

async function getErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const data = await response.json();
    return data?.error || data?.message || fallback;
  } catch {
    return fallback;
  }
}

export async function sendDeviceCommand(
  deviceId: string,
  type: string,
  payload?: Record<string, unknown>
): Promise<CommandResult> {
  const body = payload ? { type, payload } : { type };
  const response = await fetchWithAuth(`/devices/${deviceId}/commands`, {
    method: 'POST',
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(await getErrorMessage(response, 'Failed to send device command'));
  }

  const data = await response.json();
  return data.command ?? data.data ?? data;
}

export async function sendBulkCommand(
  deviceIds: string[],
  type: string,
  payload?: Record<string, unknown>
): Promise<BulkCommandResponse> {
  const body = payload ? { deviceIds, type, payload } : { deviceIds, type };
  const response = await fetchWithAuth('/devices/bulk/commands', {
    method: 'POST',
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(await getErrorMessage(response, 'Failed to send bulk command'));
  }

  const data = await response.json();
  return data.data ?? data;
}

export async function toggleMaintenanceMode(
  deviceId: string,
  enable: boolean,
  durationHours?: number
): Promise<{ success: boolean; device: any }> {
  const body = durationHours !== undefined ? { enable, durationHours } : { enable };
  const response = await fetchWithAuth(`/devices/${deviceId}/maintenance`, {
    method: 'POST',
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(await getErrorMessage(response, 'Failed to update maintenance mode'));
  }

  const data = await response.json();
  return data.data ?? data;
}
