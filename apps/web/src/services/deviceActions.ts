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

export type WakeFailureCode =
  | 'TARGET_NOT_FOUND'
  | 'NO_MACS'
  | 'NO_SUBNET'
  | 'IPV6_ONLY'
  | 'NO_RELAY'
  | 'RELAY_OVERRIDE_INVALID'
  | 'WS_SEND_FAILED';

export interface WakeResponse {
  id: string;
  deviceId: string;
  type: 'wake_on_lan';
  status: string;
  wakeAttemptId: string;
  relay: { deviceId: string; hostname: string };
  network: string;
  broadcast: string;
  macs: string[];
}

export class WakeCommandError extends Error {
  readonly code: WakeFailureCode | undefined;
  constructor(message: string, code?: WakeFailureCode) {
    super(message);
    this.name = 'WakeCommandError';
    this.code = code;
  }
}

export function wakeFriendlyErrorMessage(code: string | undefined): string | null {
  switch (code) {
    case 'NO_MACS':
      return 'No MAC address on file. The agent must check in at least once before Wake-on-LAN is available.';
    case 'NO_SUBNET':
      return 'No IPv4 record with a subnet mask in history.';
    case 'IPV6_ONLY':
      return 'Device only has IPv6 history. Wake-on-LAN requires IPv4.';
    case 'NO_RELAY':
      return 'No online peer agent at the same site and subnet to relay the packet.';
    case 'RELAY_OVERRIDE_INVALID':
      return 'Selected relay is not eligible (must be online and at the target’s site and subnet).';
    case 'WS_SEND_FAILED':
      return 'Relay agent dropped connection during dispatch. Try again.';
    case 'TARGET_NOT_FOUND':
      return 'Device not found.';
    default:
      return null;
  }
}

export async function sendWakeCommand(deviceId: string): Promise<WakeResponse> {
  const response = await fetchWithAuth(`/devices/${deviceId}/commands`, {
    method: 'POST',
    body: JSON.stringify({ type: 'wake' })
  });

  if (!response.ok) {
    let code: WakeFailureCode | undefined;
    let message = 'Failed to send wake command';
    try {
      const data = await response.json();
      if (typeof data?.code === 'string') code = data.code as WakeFailureCode;
      if (typeof data?.error === 'string') message = data.error;
      else if (typeof data?.message === 'string') message = data.message;
    } catch {
      // ignore JSON parse failure; use fallback message
    }
    throw new WakeCommandError(message, code);
  }

  return await response.json();
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

export type ScriptRunAsOverride = 'system' | 'user';

export async function executeScript(
  scriptId: string,
  deviceIds: string[],
  parameters?: Record<string, unknown>,
  runAs?: ScriptRunAsOverride
): Promise<ScriptExecuteResult> {
  const body: Record<string, unknown> = { deviceIds };
  if (parameters) body.parameters = parameters;
  if (runAs) body.runAs = runAs;

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

export async function restoreDevice(deviceId: string): Promise<{ success: boolean }> {
  const response = await fetchWithAuth(`/devices/${deviceId}/restore`, {
    method: 'POST'
  });

  if (!response.ok) {
    throw new Error(await getErrorMessage(response, 'Failed to restore device'));
  }

  const data = await response.json();
  return data.data ?? data;
}

export async function permanentDeleteDevice(deviceId: string): Promise<{ success: boolean }> {
  const response = await fetchWithAuth(`/devices/${deviceId}/permanent`, {
    method: 'DELETE'
  });

  if (!response.ok) {
    throw new Error(await getErrorMessage(response, 'Failed to permanently delete device'));
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

export async function clearDeviceSessions(deviceId: string): Promise<{ cleaned: number }> {
  const response = await fetchWithAuth(`/remote/sessions/stale?deviceId=${encodeURIComponent(deviceId)}`, {
    method: 'DELETE'
  });

  if (!response.ok) {
    throw new Error(await getErrorMessage(response, 'Failed to clear sessions'));
  }

  return await response.json();
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
