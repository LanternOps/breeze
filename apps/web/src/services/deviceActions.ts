import { fetchWithAuth } from '@/stores/auth';
import { extractApiError } from '../lib/apiError';
import type { ScriptAdmissionResult } from '@breeze/shared';

export interface CommandResult {
  id: string;
  deviceId: string;
  type: string;
  status: string;
  createdAt: string;
}

export type BulkCommandFailureCode =
  | 'TARGET_NOT_FOUND'
  | 'SITE_ACCESS_DENIED'
  | 'DECOMMISSIONED'
  | 'INSERT_FAILED';

export interface BulkCommandFailed {
  deviceId: string;
  code: BulkCommandFailureCode;
  message: string;
}

export interface BulkCommandSkipped {
  deviceId: string;
  code: 'ALREADY_PENDING';
  commandId: string;
}

export interface BulkCommandResponse {
  commands: CommandResult[];
  failed: BulkCommandFailed[];
  // Present for refresh_inventory dedup; older API responses may omit it.
  skipped?: BulkCommandSkipped[];
}

/**
 * Render a one-line failure-code summary suitable for the bulk-command
 * toast, grouping by code so a 50-device bulk doesn't spam the user.
 * Returns an empty string when there are no failures.
 */
export function summarizeBulkCommandFailures(failed: BulkCommandFailed[]): string {
  if (failed.length === 0) return '';
  const buckets: Record<string, number> = {};
  for (const f of failed) {
    const label = bulkCommandFailureLabel(f.code);
    buckets[label] = (buckets[label] ?? 0) + 1;
  }
  return Object.entries(buckets)
    .map(([label, count]) => `${count} ${label}`)
    .join('; ');
}

function bulkCommandFailureLabel(code: BulkCommandFailureCode): string {
  switch (code) {
    case 'TARGET_NOT_FOUND':
      return 'not found or access denied';
    case 'SITE_ACCESS_DENIED':
      return 'in a site you cannot access';
    case 'DECOMMISSIONED':
      return 'removed';
    case 'INSERT_FAILED':
      return 'could not be queued (server error)';
    default:
      return `with error ${code}`;
  }
}

async function getErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const data = await response.json();
    return extractApiError(data, fallback);
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

export type WakeOutcome = 'online' | 'timeout' | 'aborted' | 'still-offline';

export interface WatchWakeOutcomeOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

// Polls /devices/:id after a successful wake dispatch and resolves when the
// device transitions to 'online' or the timeout elapses. Best-effort: a
// transient HTTP error doesn't abort, it just skips one poll. Caller fires
// the user-visible follow-up toast based on the resolved outcome.
//
// Defaults: 8s poll interval, 4-minute total timeout. The existing
// 5-min wake guidance covers the worst-case BIOS POST + Windows boot;
// 4 min on the watcher prevents the toast from outlasting the user's
// attention while still catching most successful wakes.
export async function watchWakeOutcome(
  deviceId: string,
  opts: WatchWakeOutcomeOptions = {}
): Promise<WakeOutcome> {
  const interval = opts.pollIntervalMs ?? 8000;
  const totalTimeout = opts.timeoutMs ?? 4 * 60 * 1000;
  const deadline = Date.now() + totalTimeout;

  while (Date.now() < deadline) {
    if (opts.signal?.aborted) return 'aborted';

    const remaining = deadline - Date.now();
    const sleepFor = Math.min(interval, remaining);
    if (sleepFor <= 0) break;
    await waitOrAbort(sleepFor, opts.signal);
    if (opts.signal?.aborted) return 'aborted';

    try {
      const resp = await fetchWithAuth(`/devices/${deviceId}`);
      if (!resp.ok) continue;
      const body = await resp.json();
      const device = body.device ?? body.data ?? body;
      if (device?.status === 'online') return 'online';
    } catch {
      // Network blip during polling is not an error condition for the
      // wake outcome — just try again on the next tick.
    }
  }

  return 'timeout';
}

function waitOrAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
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

/** Bulk-wake result codes — same as WakeFailureCode plus two bulk-only
 *  shapes the bulk handler emits before reaching dispatchWake. */
export type BulkWakeFailureCode =
  | WakeFailureCode
  | 'DECOMMISSIONED'
  // The bulk handler also emits TARGET_NOT_FOUND for "not found OR
  // partner-scope access denied" — same as dispatchWake's own
  // TARGET_NOT_FOUND but raised earlier (before dispatchWake is invoked).
  ;

export interface BulkWakeSucceeded {
  deviceId: string;
  commandId: string;
  wakeAttemptId: string;
  relayDeviceId: string;
  relayHostname: string;
  broadcast: string;
}

export interface BulkWakeFailed {
  deviceId: string;
  code: BulkWakeFailureCode;
  message: string;
}

export interface BulkWakeSummary {
  bulkId: string;
  succeeded: BulkWakeSucceeded[];
  failed: BulkWakeFailed[];
}

/**
 * Bulk Wake-on-LAN — one HTTP round-trip, server iterates per-device with
 * a relay-pick per LAN. Server response includes per-device outcome with
 * the original WakeFailureCode preserved so the UI can group failures
 * by reason in the summary toast.
 *
 * 412/422 from the server (validation, decommissioned-only selection,
 * etc.) is surfaced as a thrown Error so the caller's catch path can
 * show a single error toast instead of treating the entire batch as
 * "0 succeeded."
 */
export async function sendBulkWakeCommand(deviceIds: string[]): Promise<BulkWakeSummary> {
  const response = await fetchWithAuth('/devices/bulk/commands', {
    method: 'POST',
    body: JSON.stringify({ deviceIds, type: 'wake' })
  });
  if (!response.ok) {
    throw new Error(await getErrorMessage(response, 'Failed to send bulk wake command'));
  }
  return await response.json();
}

/**
 * Render a one-line failure-code summary suitable for the bulk-wake toast,
 * grouping by code. Returns an empty string when there are no failures.
 *
 * Example: "3 have no online peer at their site; 1 has no MAC on file"
 */
export function summarizeBulkWakeFailures(failed: BulkWakeFailed[]): string {
  if (failed.length === 0) return '';
  const buckets: Record<string, number> = {};
  for (const f of failed) {
    const label = bulkWakeFailureLabel(f.code);
    buckets[label] = (buckets[label] ?? 0) + 1;
  }
  return Object.entries(buckets)
    .map(([label, count]) => `${count} ${label}`)
    .join('; ');
}

function bulkWakeFailureLabel(code: string): string {
  switch (code) {
    case 'NO_RELAY':
      return 'with no online peer at their site';
    case 'NO_MACS':
      return 'with no MAC on file (agent has not checked in)';
    case 'NO_SUBNET':
    case 'IPV6_ONLY':
      return 'with no usable IPv4 history';
    case 'WS_SEND_FAILED':
      return 'had relay disconnect mid-dispatch — retry';
    case 'TARGET_NOT_FOUND':
      return 'not found or access denied';
    case 'DECOMMISSIONED':
      return 'removed';
    case 'RELAY_OVERRIDE_INVALID':
      // Bulk path never uses override; surface generically if it ever
      // does appear so we notice in telemetry.
      return 'with invalid relay override';
    default:
      return `with error ${code}`;
  }
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

export type ScriptRunAsOverride = 'system' | 'user';

export async function executeScript(
  scriptId: string,
  deviceIds: string[],
  parameters?: Record<string, unknown>,
  runAs?: ScriptRunAsOverride,
  targetSessionId?: number
): Promise<ScriptAdmissionResult> {
  const body: Record<string, unknown> = { deviceIds };
  if (parameters) body.parameters = parameters;
  if (runAs) body.runAs = runAs;
  if (targetSessionId != null) body.targetSessionId = targetSessionId;

  const response = await fetchWithAuth(`/scripts/${scriptId}/execute`, {
    method: 'POST',
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(await getErrorMessage(response, 'Failed to execute script'));
  }

  return await response.json() as ScriptAdmissionResult;
}

export interface RemoveDeviceOptions {
  /**
   * Queue a durable self_uninstall alongside the Remove (#3986/#4001). The
   * API defaults this to false for back-compat; the WEB defaults it to true
   * in RemoveDeviceDialog — defaulting to "leave installed" is what produces
   * zombie agents nobody notices (owner decision 2026-08-24).
   */
  uninstallAgent: boolean;
}

export async function decommissionDevice(
  deviceId: string,
  opts: RemoveDeviceOptions,
): Promise<{ success: boolean; uninstallQueued?: boolean }> {
  const response = await fetchWithAuth(`/devices/${deviceId}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uninstallAgent: opts.uninstallAgent }),
  });

  if (!response.ok) {
    throw new Error(await getErrorMessage(response, 'Failed to remove device'));
  }

  const data = await response.json();
  return data.data ?? data;
}

/**
 * Read-only knobs the Remove dialog needs. `uninstallDrainWindowHours` is
 * env-driven on the API (DEVICE_UNINSTALL_DRAIN_WINDOW_HOURS) — operators tune
 * it per deployment, so the web must fetch it and never hardcode it.
 */
export async function fetchRemovalConfig(): Promise<{ uninstallDrainWindowHours: number }> {
  const response = await fetchWithAuth('/devices/removal-config');
  if (!response.ok) {
    throw new Error(await getErrorMessage(response, 'Failed to load removal settings'));
  }
  return response.json();
}

/**
 * Link 2+ devices as boot profiles of one physical machine (#2138). All must
 * belong to the same organization and be currently unlinked; the API enforces
 * both.
 */
export async function linkDevicesMultiboot(
  deviceIds: string[],
  name?: string,
): Promise<{ id: string }> {
  const response = await fetchWithAuth('/devices/link-groups', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(name ? { deviceIds, name } : { deviceIds }),
  });

  if (!response.ok) {
    throw new Error(await getErrorMessage(response, 'Failed to link devices'));
  }

  const data = await response.json();
  return data.data ?? data;
}

/**
 * Create a vm_host link group (#2308): `hostDeviceId` becomes the host server,
 * every other member of `deviceIds` becomes a guest VM nested under it in the
 * device list. `hostDeviceId` must be included in `deviceIds`; same-org and
 * not-already-linked rules match the multiboot path (the API enforces all).
 */
export async function linkDevicesVmHost(
  hostDeviceId: string,
  deviceIds: string[],
  name?: string,
): Promise<{ id: string }> {
  const response = await fetchWithAuth('/devices/link-groups', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'vm_host', hostDeviceId, deviceIds, ...(name ? { name } : {}) }),
  });

  if (!response.ok) {
    throw new Error(await getErrorMessage(response, 'Failed to link devices'));
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

export async function permanentDeleteDevice(
  deviceId: string
): Promise<{ success: boolean; agentUninstallSent?: boolean; warning?: string }> {
  const response = await fetchWithAuth(`/devices/${deviceId}/permanent`, {
    method: 'DELETE'
  });

  if (!response.ok) {
    throw new Error(await getErrorMessage(response, 'Failed to permanently delete device'));
  }

  const data = await response.json();
  return data.data ?? data;
}

export interface BulkDecommissionFailed {
  id: string;
  hostname: string;
}

export interface BulkDecommissionResult {
  succeeded: number;
  failed: BulkDecommissionFailed[];
}

/**
 * Fires one `DELETE /devices/:id` per device. Per-device try/catch: one
 * device 404'ing/erroring must NOT abort the batch and silently skip every
 * device after it (mirrors the maintenance-toggle loop in DevicesPage.tsx).
 * Collects id + hostname for every failure so the caller can render a
 * summary naming which devices failed, not just a count.
 */
export async function bulkDecommissionDevices(
  devices: Array<{ id: string; hostname: string }>,
  opts: RemoveDeviceOptions,
): Promise<BulkDecommissionResult> {
  let succeeded = 0;
  const failed: BulkDecommissionFailed[] = [];

  for (const device of devices) {
    try {
      // One radio for the whole selection (#3987) — every DELETE carries the
      // same agent choice the operator made once in RemoveDeviceDialog.
      await decommissionDevice(device.id, opts);
      succeeded++;
    } catch {
      failed.push({ id: device.id, hostname: device.hostname || device.id });
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

export type LiveSession = {
  sessionId: number;
  username: string;
  state: string;
  type: string;
  helperConnected: boolean;
  idleMinutes: number | null;
};

/**
 * Synchronously probe the device's live interactive sessions (Task 2:
 * GET /devices/:id/sessions/live). Throws with the server's `error` string
 * on a non-OK response so the caller can surface the agent-offline / probe
 * failure loudly rather than showing an empty picker.
 */
export async function fetchLiveSessions(deviceId: string): Promise<LiveSession[]> {
  const response = await fetchWithAuth(`/devices/${deviceId}/sessions/live`);
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error((body as { error?: string } | null)?.error ?? 'Failed to list sessions');
  }
  return (body as { data?: { sessions?: LiveSession[] } } | null)?.data?.sessions ?? [];
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

// ---------------------------------------------------------------------------
// Bulk lifecycle on REMOVED devices (#2787)
// ---------------------------------------------------------------------------

export type BulkLifecycleFailureCode =
  | 'NOT_FOUND'
  | 'NOT_REMOVED'
  | 'UNINSTALL_PENDING'
  | 'SITE_ACCESS_DENIED'
  | 'ERROR';

export interface BulkLifecycleFailure {
  deviceId: string;
  code: BulkLifecycleFailureCode | string;
  message: string;
}

export interface BulkRestoreResult {
  succeeded: Array<{ deviceId: string; uninstallAlreadyDispatched: boolean }>;
  failed: BulkLifecycleFailure[];
}

/**
 * Restore several removed devices in one call. Synchronous on the API side —
 * the response already carries the final per-device outcome, so there is
 * nothing to poll.
 *
 * Never throws for a per-DEVICE failure; a rejection here means the whole
 * request was refused (auth, MFA, >500 ids).
 */
export async function bulkRestoreDevices(deviceIds: string[]): Promise<BulkRestoreResult> {
  const response = await fetchWithAuth('/devices/bulk/restore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceIds }),
  });

  if (!response.ok) {
    throw new Error(await getErrorMessage(response, 'Failed to restore devices'));
  }

  return await response.json();
}

export interface BulkPurgeStart {
  jobId: string;
  accepted: number;
  rejected: BulkLifecycleFailure[];
}

/**
 * Thrown when the API refuses the WHOLE selection (409). Carries the per-device
 * reasons so the caller can say which device failed which check — a plain
 * `Error` would leave the operator with "no device can be deleted" and no way
 * to tell why.
 */
export class BulkPurgeRejectedError extends Error {
  readonly rejected: BulkLifecycleFailure[];
  constructor(message: string, rejected: BulkLifecycleFailure[]) {
    super(message);
    this.name = 'BulkPurgeRejectedError';
    this.rejected = rejected;
  }
}

/**
 * Start an async bulk permanent delete. Returns as soon as the job is queued —
 * poll `fetchPurgeRun(jobId)` for the outcome.
 *
 * A partial rejection is NOT an error: the API returns 202 with `rejected`
 * alongside `accepted`, and the caller surfaces both.
 */
export async function startBulkPurge(deviceIds: string[]): Promise<BulkPurgeStart> {
  const response = await fetchWithAuth('/devices/bulk/permanent-delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceIds }),
  });

  if (!response.ok) {
    // Parsed ONCE, by hand: `getErrorMessage` consumes the body, and the 409
    // carries `rejected` alongside `error` — reading it through that helper
    // would leave the stream used up and the reasons unrecoverable.
    const body = (await response.json().catch(() => null)) as
      | { error?: unknown; rejected?: BulkLifecycleFailure[] }
      | null;
    const message = body
      ? extractApiError(body, 'Failed to start the permanent delete')
      : 'Failed to start the permanent delete';
    if (response.status === 409) {
      throw new BulkPurgeRejectedError(message, body?.rejected ?? []);
    }
    throw new Error(message);
  }

  return await response.json();
}

export interface PurgeRun {
  state: string;
  progress: { done: number; total: number };
  result: { purged: string[]; skipped: Array<{ deviceId: string; code: string }> } | null;
  failedReason: string | null;
}

/** Poll interval for `fetchPurgeRun`. */
export const PURGE_POLL_INTERVAL_MS = 2000;

export async function fetchPurgeRun(jobId: string): Promise<PurgeRun> {
  const response = await fetchWithAuth(`/devices/bulk/purge-runs/${encodeURIComponent(jobId)}`);

  if (!response.ok) {
    throw new Error(await getErrorMessage(response, 'Failed to read the permanent-delete run'));
  }

  return await response.json();
}
