import * as SecureStore from 'expo-secure-store';
import * as Sentry from '@sentry/react-native';

import { getServerUrl } from './serverConfig';
import { getOrCreateInstallationId } from './installationId';
import { fetchWithTimeout } from './fetchWithTimeout';

export const FALLBACK_API_BASE_URL =
  process.env.EXPO_PUBLIC_API_URL || 'http://localhost:3001';
const API_PREFIX = '/api/v1/mobile';
const API_CORE_PREFIX = '/api/v1';
const CSRF_HEADER_NAME = 'x-breeze-csrf';
const CSRF_HEADER_VALUE = '1';
export const MOBILE_DEVICE_ID_HEADER = 'x-breeze-mobile-device-id';
export const DEVICE_BLOCKED_CODE = 'device_blocked';

type DeviceBlockedListener = (reason: string | null) => void;
const deviceBlockedListeners = new Set<DeviceBlockedListener>();

/**
 * Subscribe to the global "this device just got blocked" signal. The first
 * API response carrying `code: device_blocked` triggers it; the app should
 * sign out and render the blocked-state screen.
 */
export function onDeviceBlocked(listener: DeviceBlockedListener): () => void {
  deviceBlockedListeners.add(listener);
  return () => {
    deviceBlockedListeners.delete(listener);
  };
}

function notifyDeviceBlocked(reason: string | null): void {
  for (const listener of deviceBlockedListeners) {
    try {
      listener(reason);
    } catch (err) {
      console.error('[api] device-blocked listener threw', err);
    }
  }
}

// Types
export interface Alert {
  id: string;
  title: string;
  message: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  type: string;
  deviceId?: string;
  deviceName?: string;
  acknowledged: boolean;
  acknowledgedAt?: string;
  acknowledgedBy?: string;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface Device {
  id: string;
  name: string;
  hostname?: string;
  ipAddress?: string;
  os?: string;
  agentVersion?: string;
  serialNumber?: string;
  status: 'online' | 'offline' | 'warning';
  lastSeen?: string;
  organizationId?: string;
  organizationName?: string;
  siteId?: string;
  siteName?: string;
  groupId?: string;
  groupName?: string;
  metrics?: {
    cpuUsage?: number;
    memoryUsage?: number;
    diskUsage?: number;
  };
  createdAt: string;
  updatedAt: string;
}

export interface User {
  id: string;
  email: string;
  name: string;
  role: string;
  organizationId?: string;
  partnerId?: string;
}

export interface LoginResponse {
  token: string;
  user: User;
  /** #2707: single-use approver-register grant minted at login; memory-only. */
  registerGrant: string | null;
}

export type MfaMethod = 'totp' | 'sms';

export interface MfaChallenge {
  tempToken: string;
  mfaMethod: MfaMethod;
  phoneLast4: string | null;
}

export type LoginResult =
  | { kind: 'success'; token: string; user: User; registerGrant: string | null }
  | { kind: 'mfaRequired'; challenge: MfaChallenge };

export interface ApiError {
  message: string;
  code?: string;
  statusCode?: number;
}

interface ListResponse<T> {
  data: T[];
  pagination?: {
    page: number;
    limit: number;
    total: number;
    /** Keyset cursor for the next page; null on the last page. */
    nextCursor?: string | null;
  };
}

interface AuthTokensPayload {
  accessToken: string;
  refreshToken?: string;
}

interface LoginPayload {
  user?: User;
  tokens?: AuthTokensPayload;
  accessToken?: string;
  mfaRequired?: boolean;
  tempToken?: string;
  mfaMethod?: MfaMethod;
  phoneLast4?: string | null;
  error?: string;
  /** #2707: single-use approver-register grant; mobile-header-gated. */
  authenticatorRegisterGrantId?: string;
}

type MobileAlertRecord = {
  id: string;
  title: string;
  message: string;
  severity: Alert['severity'];
  status: 'active' | 'acknowledged' | 'resolved' | 'suppressed';
  triggeredAt?: string;
  createdAt?: string;
  acknowledgedAt?: string | null;
  acknowledgedBy?: string | null;
  resolvedAt?: string | null;
  type?: string;
  deviceId?: string | null;
  deviceName?: string | null;
  device?: {
    id?: string;
    hostname?: string | null;
  } | null;
  orgId?: string;
};

type MobileDeviceRecord = {
  id: string;
  orgId?: string;
  siteId?: string | null;
  hostname?: string | null;
  displayName?: string | null;
  osType?: string | null;
  status?: string;
  lastSeenAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  metrics?: {
    cpuUsage?: number;
    memoryUsage?: number;
    diskUsage?: number;
  };
  siteName?: string;
};

// Token management
const TOKEN_KEY = 'breeze_auth_token';

async function getToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(TOKEN_KEY);
  } catch {
    return null;
  }
}

// Request helper
async function requestWithPrefix<T>(
  endpoint: string,
  prefix: string,
  options: RequestInit = {},
  timeoutMs?: number
): Promise<T> {
  const token = await getToken();
  const method = (options.method ?? 'GET').toUpperCase();

  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...options.headers,
  };

  if (token) {
    (headers as Record<string, string>)['Authorization'] = `Bearer ${token}`;
  }

  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    (headers as Record<string, string>)[CSRF_HEADER_NAME] = CSRF_HEADER_VALUE;
  }

  // Always send the per-install id so the API can recognise this phone. This
  // used to be a harmless soft-matching hint (the lifecycle/lockout flow), but
  // post-#2707 the server also gates login-time register_approver_device grant
  // minting on this header — if SecureStore fails here, the phone never gets a
  // grant, approver registration permanently defers, and there is no recovery:
  // ApprovalGate's deferred-banner "sign out and back in" advice cannot fix a
  // device that can't produce an installation id at all. Report failures so
  // they're observable instead of silently capping the phone at L1 forever.
  try {
    const installationId = await getOrCreateInstallationId();
    if (installationId) {
      (headers as Record<string, string>)[MOBILE_DEVICE_ID_HEADER] = installationId;
    }
  } catch (e) {
    Sentry.captureMessage('installation id unavailable for mobile-device header', {
      level: 'warning',
      tags: { area: 'mobile-device-id-header' },
      extra: { errorName: (e as Error)?.name ?? 'unknown' },
    });
  }

  const baseUrl = (await getServerUrl()) || FALLBACK_API_BASE_URL;
  const url = `${baseUrl}${prefix}${endpoint}`;
  const response = await fetchWithTimeout(
    url,
    { ...options, headers, credentials: 'include' },
    timeoutMs
  );

  if (!response.ok) {
    const body = await response.json().catch(() => ({} as Record<string, unknown>));
    const code = typeof body.code === 'string' ? body.code : undefined;
    if (code === DEVICE_BLOCKED_CODE) {
      const reason = typeof body.reason === 'string' ? body.reason : null;
      notifyDeviceBlocked(reason);
    }
    const error: ApiError = {
      message:
        (typeof body.error === 'string' && body.error)
        || (typeof body.message === 'string' && body.message)
        || 'An error occurred',
      code,
      statusCode: response.status
    };
    throw error;
  }

  // Handle empty responses
  const text = await response.text();
  if (!text) {
    return {} as T;
  }

  return JSON.parse(text);
}

async function request<T>(
  endpoint: string,
  options: RequestInit = {},
  timeoutMs?: number
): Promise<T> {
  return requestWithPrefix<T>(endpoint, API_PREFIX, options, timeoutMs);
}

/**
 * Issue a request against the core `/api/v1` surface from a sibling service
 * module. Exported so feature services (tickets, …) reuse this hardened path
 * — auth header, CSRF header, per-install device id, and the `device_blocked`
 * notification — instead of re-implementing `fetch` and silently dropping all
 * four (see `services/search.ts` for the copy this exists to prevent spreading).
 */
export async function coreRequest<T>(
  endpoint: string,
  options: RequestInit = {},
  timeoutMs?: number
): Promise<T> {
  return requestWithPrefix<T>(endpoint, API_CORE_PREFIX, options, timeoutMs);
}

export type DeviceAction = 'reboot' | 'shutdown' | 'wake' | 'update';

function mapAlert(alert: MobileAlertRecord): Alert {
  const normalizedSeverity: Alert['severity'] =
    alert.severity === 'info' ? 'low' : alert.severity;
  const createdAt = alert.triggeredAt || alert.createdAt || new Date().toISOString();
  return {
    id: alert.id,
    title: alert.title,
    message: alert.message,
    severity: normalizedSeverity,
    type: alert.type || 'alert',
    deviceId: alert.device?.id || alert.deviceId || undefined,
    deviceName: alert.device?.hostname || alert.deviceName || undefined,
    acknowledged: alert.status === 'acknowledged' || alert.status === 'resolved' || Boolean(alert.acknowledgedAt),
    acknowledgedAt: alert.acknowledgedAt || undefined,
    acknowledgedBy: alert.acknowledgedBy || undefined,
    createdAt,
    updatedAt: alert.resolvedAt || alert.acknowledgedAt || createdAt,
    metadata: { orgId: alert.orgId, status: alert.status }
  };
}

function mapStatus(status: string | undefined): Device['status'] {
  if (status === 'online') return 'online';
  if (status === 'offline' || status === 'decommissioned') return 'offline';
  return 'warning';
}

function mapDevice(device: MobileDeviceRecord): Device {
  const createdAt = device.createdAt || new Date(0).toISOString();
  const updatedAt = device.updatedAt || createdAt;
  return {
    id: device.id,
    name: device.displayName || device.hostname || device.id,
    hostname: device.hostname || undefined,
    os: device.osType || undefined,
    status: mapStatus(device.status),
    lastSeen: device.lastSeenAt || undefined,
    organizationId: device.orgId || undefined,
    siteId: device.siteId || undefined,
    siteName: device.siteName || undefined,
    metrics: device.metrics,
    createdAt,
    updatedAt
  };
}

// Auth API
export async function login(email: string, password: string): Promise<LoginResult> {
  const response = await requestWithPrefix<LoginPayload>('/auth/login', API_CORE_PREFIX, {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });

  if (response.mfaRequired) {
    if (!response.tempToken || !response.mfaMethod) {
      throw { message: 'Invalid MFA challenge from server' } as ApiError;
    }
    return {
      kind: 'mfaRequired',
      challenge: {
        tempToken: response.tempToken,
        mfaMethod: response.mfaMethod,
        phoneLast4: response.phoneLast4 ?? null,
      },
    };
  }

  const token = response.tokens?.accessToken || response.accessToken;
  if (!response.user || !token) {
    throw { message: response.error || 'Invalid login response' } as ApiError;
  }

  return {
    kind: 'success',
    token,
    user: response.user,
    registerGrant: response.authenticatorRegisterGrantId ?? null,
  };
}

export async function verifyMfa(code: string, tempToken: string): Promise<LoginResponse> {
  const response = await requestWithPrefix<LoginPayload>('/auth/mfa/verify', API_CORE_PREFIX, {
    method: 'POST',
    body: JSON.stringify({ code, tempToken }),
  });

  const token = response.tokens?.accessToken || response.accessToken;
  if (!response.user || !token) {
    throw { message: response.error || 'Invalid MFA response' } as ApiError;
  }

  return { token, user: response.user, registerGrant: response.authenticatorRegisterGrantId ?? null };
}

export async function sendMfaSms(tempToken: string): Promise<void> {
  await requestWithPrefix('/auth/mfa/sms/send', API_CORE_PREFIX, {
    method: 'POST',
    body: JSON.stringify({ tempToken }),
  });
}

export async function logout(): Promise<void> {
  try {
    await requestWithPrefix('/auth/logout', API_CORE_PREFIX, { method: 'POST' });
  } catch {
    // Ignore logout errors
  }
}

export async function refreshToken(): Promise<{ token: string }> {
  const response = await requestWithPrefix<{ tokens?: AuthTokensPayload; accessToken?: string }>(
    '/auth/refresh',
    API_CORE_PREFIX,
    {
      method: 'POST',
      body: JSON.stringify({})
    });
  const token = response.tokens?.accessToken || response.accessToken;
  if (!token) {
    throw { message: 'Failed to refresh token' } as ApiError;
  }
  return { token };
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  await requestWithPrefix('/auth/change-password', API_CORE_PREFIX, {
    method: 'POST',
    body: JSON.stringify({ currentPassword, newPassword }),
  });
}

// Alerts API
/**
 * Fetch the alert inbox.
 *
 * Defaults to `status=active` because the inbox is a RECENCY window, not a
 * priority one: it returns the newest non-dismissed alerts and the client asks
 * for one page. On a real fleet the page fills with resolved low-severity
 * noise and never reaches anything actionable — measured on a 7,023-alert
 * tenant, all 50 rows came back `low` and 48 of them resolved, so the Systems
 * screen rendered zero issues while 18 unacknowledged high/medium alerts sat
 * just outside the window. Asking for active-only makes the same page carry
 * what the screen actually renders.
 */
export async function getAlerts(status: 'active' | 'all' = 'active'): Promise<Alert[]> {
  const path = status === 'active' ? '/alerts/inbox?status=active' : '/alerts/inbox';
  const response = await request<ListResponse<MobileAlertRecord>>(path);
  return response.data.map(mapAlert);
}

export async function getAlert(id: string): Promise<Alert> {
  const response = await requestWithPrefix<MobileAlertRecord>(`/alerts/${id}`, API_CORE_PREFIX);
  return mapAlert(response);
}

/**
 * Acknowledge an alert.
 *
 * Given a longer timeout than the 15s default because this write is slow on
 * real deployments: the API awaits its local event handlers inside the request
 * path (see upstream #1105 — the server itself logs "held a pooled connection
 * ... for 15439ms"). Measured acknowledges of 13.4s and 15.2s returned 200
 * while the client had already aborted at 15s and told the user it failed,
 * which invites a retry of an action that already succeeded.
 */
export const ACKNOWLEDGE_TIMEOUT_MS = 45000;

export interface BulkAckOutcome {
  acknowledged: string[];
  failed: string[];
}

/**
 * How many acknowledges run at once.
 *
 * Deliberately small. Each request is slow server-side (13-15s measured,
 * because the API publishes its event inside the request path) and holds a
 * pooled DB connection for its duration, so firing a whole selection at once
 * would pile concurrent long-lived connections onto the exact resource that is
 * already under pressure. Four keeps a 20-alert batch to roughly a minute
 * while the UI stays responsive, without acting as a load generator.
 */
export const ACK_CONCURRENCY = 4;

/**
 * Acknowledge many alerts.
 *
 * Uses the per-alert MOBILE endpoint rather than core `POST /alerts/bulk`:
 * bulk requires `alerts:write`, while Technician roles are seeded with
 * `alerts:acknowledge` only, so the bulk route 403s for exactly the people who
 * triage alerts from a phone. Slower, but it works for every role.
 *
 * Never rejects — the caller needs to know which ids landed so the failures
 * can be restored individually.
 */
export async function acknowledgeAlerts(ids: string[]): Promise<BulkAckOutcome> {
  const acknowledged: string[] = [];
  const failed: string[] = [];
  const queue = [...ids];

  async function worker(): Promise<void> {
    for (;;) {
      const id = queue.shift();
      if (!id) return;
      try {
        await acknowledgeAlert(id);
        acknowledged.push(id);
      } catch {
        failed.push(id);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(ACK_CONCURRENCY, ids.length) }, () => worker())
  );
  return { acknowledged, failed };
}

export async function acknowledgeAlert(id: string): Promise<Alert> {
  const response = await request<MobileAlertRecord>(
    `/alerts/${id}/acknowledge`,
    { method: 'POST' },
    ACKNOWLEDGE_TIMEOUT_MS
  );
  return mapAlert(response);
}

export async function getAlertStats(): Promise<{
  total: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  acknowledged: number;
}> {
  const response = await requestWithPrefix<{
    bySeverity: Record<string, number>;
    byStatus: Record<string, number>;
    total: number;
  }>('/alerts/summary', API_CORE_PREFIX);
  return {
    total: response.total || 0,
    critical: response.bySeverity?.critical || 0,
    high: response.bySeverity?.high || 0,
    medium: response.bySeverity?.medium || 0,
    low: response.bySeverity?.low || 0,
    acknowledged: response.byStatus?.acknowledged || 0
  };
}

// Devices API
/** Server cap on `limit` (patches/helpers.ts MAX_PAGE_LIMIT). */
const DEVICE_PAGE_LIMIT = 200;
/**
 * Safety stop for the cursor walk. 20 pages x 200 = 4,000 devices, well beyond
 * any fleet that belongs on a phone screen, and it bounds the loop if the
 * server ever returns a non-advancing cursor.
 */
const MAX_DEVICE_PAGES = 20;

/**
 * Fetch devices, following the cursor to the end of the fleet.
 *
 * A single request returns `limit` rows (default 50, capped at 200), so asking
 * once silently truncates: a 210-device tenant showed 50 and any client-side
 * org filter then searched only that first page — an org whose machines sat
 * further down rendered as empty. `orgId` is pushed to the server so a scoped
 * view pages through that org rather than through the whole fleet.
 */
export async function getDevices(orgId?: string | null): Promise<Device[]> {
  const out: MobileDeviceRecord[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < MAX_DEVICE_PAGES; page += 1) {
    const params = new URLSearchParams({ limit: String(DEVICE_PAGE_LIMIT) });
    if (orgId) params.set('orgId', orgId);
    if (cursor) params.set('cursor', cursor);

    const response = await request<ListResponse<MobileDeviceRecord>>(
      `/devices?${params.toString()}`
    );
    const rows = Array.isArray(response.data) ? response.data : [];
    out.push(...rows);

    const next = response.pagination?.nextCursor ?? null;
    // Stop on a null cursor, a short page, or a cursor that did not advance —
    // the last of these would otherwise spin until the page cap.
    if (!next || next === cursor || rows.length === 0) break;
    cursor = next;
  }

  return out.map(mapDevice);
}

export async function getDevice(id: string): Promise<Device> {
  const response = await requestWithPrefix<MobileDeviceRecord>(`/devices/${id}`, API_CORE_PREFIX);
  return mapDevice(response);
}

export async function getDeviceMetrics(id: string): Promise<Device['metrics']> {
  const response = await requestWithPrefix<{
    data?: {
      avgCpuPercent?: number;
      avgRamPercent?: number;
      avgDiskPercent?: number;
    }[];
  }>(`/devices/${id}/metrics`, API_CORE_PREFIX);
  const latest = response.data?.[response.data.length - 1];
  if (!latest) return undefined;
  return {
    cpuUsage: latest.avgCpuPercent,
    memoryUsage: latest.avgRamPercent,
    diskUsage: latest.avgDiskPercent
  };
}

export async function sendDeviceAction(
  deviceId: string,
  action: DeviceAction
): Promise<{ id: string; type: DeviceAction }> {
  const response = await requestWithPrefix<{ id?: string; commandId?: string }>(
    `/devices/${deviceId}/commands`,
    API_CORE_PREFIX,
    {
    method: 'POST',
    body: JSON.stringify({ type: action, payload: {} }),
  });
  return {
    id: response.id || response.commandId || '',
    type: action
  };
}

export type WakeFailureCode =
  | 'TARGET_NOT_FOUND'
  | 'NO_MACS'
  | 'NO_SUBNET'
  | 'IPV6_ONLY'
  | 'NO_RELAY'
  | 'RELAY_OVERRIDE_INVALID'
  | 'WS_SEND_FAILED';

export interface WakeMobileResponse {
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

// Throws an ApiError on non-2xx — the caller can read err.code for the
// pre-flight failure reason (NO_MACS, NO_RELAY, etc.) and surface a friendly
// message. requestWithPrefix already preserves both code and statusCode.
export async function sendWakeAction(deviceId: string): Promise<WakeMobileResponse> {
  return requestWithPrefix<WakeMobileResponse>(
    `/devices/${deviceId}/commands`,
    API_CORE_PREFIX,
    {
      method: 'POST',
      body: JSON.stringify({ type: 'wake' }),
    },
  );
}

// Push notification registration
export async function registerPushToken(token: string, platform: 'ios' | 'android'): Promise<void> {
  await request('/notifications/register', {
    method: 'POST',
    body: JSON.stringify({ token, platform }),
  });
}

export async function unregisterPushToken(token: string): Promise<void> {
  await request('/notifications/unregister', {
    method: 'POST',
    body: JSON.stringify({ token }),
  });
}

// User API
export async function getCurrentUser(): Promise<User> {
  const response = await requestWithPrefix<{ user: User }>('/auth/me', API_CORE_PREFIX);
  return response.user;
}

export async function updateUserProfile(data: Partial<User>): Promise<User> {
  const current = await getCurrentUser();
  return requestWithPrefix<User>(`/users/${current.id}`, API_CORE_PREFIX, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}
