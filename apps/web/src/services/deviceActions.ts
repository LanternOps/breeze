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

export interface ScriptExecuteResult {
  batchId: string | null;
  scriptId: string;
  devicesTargeted: number;
  executions: Array<{ executionId: string; deviceId: string; commandId: string }>;
  status: string;
}

export async function executeScript(
  scriptId: string,
  deviceIds: string[],
  parameters?: Record<string, unknown>
): Promise<ScriptExecuteResult> {
  const body: Record<string, unknown> = { deviceIds };
  if (parameters) body.parameters = parameters;

  const response = await fetchWithAuth(`/scripts/${scriptId}/execute`, {
    method: 'POST',
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(await getErrorMessage(response, 'Failed to execute script'));
  }

  return await response.json();
}

export async function decommissionDevice(deviceId: string): Promise<{ success: boolean }> {
  const response = await fetchWithAuth(`/devices/${deviceId}`, {
    method: 'DELETE'
  });

  if (!response.ok) {
    throw new Error(await getErrorMessage(response, 'Failed to decommission device'));
  }

  const data = await response.json();
  return data.data ?? data;
}

export async function bulkDecommissionDevices(
  deviceIds: string[]
): Promise<{ succeeded: number; failed: number }> {
  let succeeded = 0;
  let failed = 0;

  for (const id of deviceIds) {
    try {
      await decommissionDevice(id);
      succeeded++;
    } catch {
      failed++;
    }
  }

  return { succeeded, failed };
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
