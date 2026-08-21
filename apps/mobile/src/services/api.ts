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
  options: RequestInit = {}
): Promise<T> {
  return requestWithPrefix<T>(endpoint, API_CORE_PREFIX, options);
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
 * Server caps `limit` at 100 for this route — `/alerts/inbox` runs its query
 * through `getPagination`, which does `Math.min(100, ...)` and CLAMPS rather
 * than rejecting, so asking for more just returns 100 with a 200.
 */
const ALERT_PAGE_LIMIT = 100;

/**
 * Fetch the alert inbox, paging to the end.
 *
 * Defaults to `status=active` because the inbox is a RECENCY window, not a
 * priority one: it returns the newest non-dismissed alerts. On a real fleet a
 * single page fills with resolved low-severity noise and never reaches anything
 * actionable — measured on a 7,023-alert tenant, all 50 rows came back `low`
 * and 48 of them resolved, so the Systems screen rendered zero issues while 18
 * unacknowledged high/medium alerts sat just outside the window.
 *
 * Asking for active-only narrows what the page carries, but it does not make
 * one page enough: this used to send no `limit` at all and discard `pagination`
 * entirely, so it saw the first 50 by recency and the Active Issues section
 * plus every org rollup count silently described a 50-alert sample as the whole
 * fleet (issue #3753). It now asks for the server's maximum and, crucially,
 * reports whether that was everything.
 */
export async function getAlertsPaged(
  status: 'active' | 'all' = 'active'
): Promise<PagedResult<Alert>> {
  const { rows, total, truncated } = await fetchPage<MobileAlertRecord>((params) => {
    if (status === 'active') params.set('status', 'active');
    return `/alerts/inbox?${params.toString()}`;
  }, ALERT_PAGE_LIMIT);

  if (truncated) {
    Sentry.captureMessage('alert inbox is showing a partial set', {
      level: 'warning',
      tags: { area: 'alert-inbox' },
      extra: { returned: rows.length, total, status, pageLimit: ALERT_PAGE_LIMIT },
    });
  }

  return { items: rows.map(mapAlert), total, truncated };
}

export async function getAlerts(status: 'active' | 'all' = 'active'): Promise<Alert[]> {
  return (await getAlertsPaged(status)).items;
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
/**
 * Server cap on `limit` for THIS route. `/mobile/devices` runs its query
 * through `getPagination`, which does `Math.min(100, ...)` — it CLAMPS rather
 * than rejecting, so asking for more is silently downgraded with nothing in the
 * response to say so.
 *
 * This previously read 200, citing `patches/helpers.ts MAX_PAGE_LIMIT`. That is
 * a different route's constant (the patches endpoints do cap at 200); the
 * mobile route never has. The effect was a walk that read as 4,000 devices and
 * delivered 2,000.
 */
const DEVICE_PAGE_LIMIT = 100;

/**
 * A walk's result together with whether it actually got everything.
 *
 * `total` is the server's exact count for the same filter. `truncated` is the
 * only honest answer to "is this the whole set?" — a caller that receives a
 * bare array cannot distinguish N items from the first N of more, and every
 * count, filter and empty-state rendered over it then looks authoritative
 * while being wrong (issue #3753).
 */
export interface PagedResult<T> {
  items: T[];
  /** Server's exact count for this filter, or null if it reported none. */
  total: number | null;
  /**
   * True when this is NOT the whole set — either the server counted more than
   * came back, or it reported no count and the page came back full.
   */
  truncated: boolean;
}

/**
 * Fetch ONE page of a mobile list endpoint and report how much of the set it
 * represents.
 *
 * Deliberately one request, not a walk. Neither pagination mode on
 * `/mobile/devices` or `/mobile/alerts/inbox` can produce a trustworthy
 * full-set walk today:
 *
 *  - CURSOR mode is unreachable. The routes compute `nextCursor` only inside
 *    `if (cursor)`, so a cold-start caller — which has no cursor to send — gets
 *    `nextCursor: null` on its first response and can never obtain the token
 *    for page two. The previous walk here treated that null as clean
 *    exhaustion, so it stopped after one page AND suppressed its own truncation
 *    warning.
 *  - OFFSET mode is reachable but skews. Both routes order by a MUTABLE key
 *    (`last_seen_at`, rewritten by every heartbeat), so rows reorder between
 *    page requests: page two can repeat rows page one already returned and
 *    never return the ones that moved ahead of the offset. A row-count check
 *    cannot detect that, because the duplicates make the count come out right.
 *
 * So the walk is not the fix — the honest claim is. One page, plus the server's
 * exact `total`, lets the caller say "showing N of M" instead of presenting a
 * sample as the whole set. Fixing the underlying keyset (the way
 * `routes/devices/core.ts` did, by keying cursor mode on the NOT NULL,
 * immutable `hostname`) is filed separately.
 */
async function fetchPage<TRow>(
  buildPath: (params: URLSearchParams) => string,
  pageLimit: number
): Promise<{ rows: TRow[]; total: number | null; truncated: boolean }> {
  const params = new URLSearchParams({ limit: String(pageLimit) });
  const response = await request<ListResponse<TRow>>(buildPath(params));
  const rows = Array.isArray(response.data) ? response.data : [];
  const total = typeof response.pagination?.total === 'number' ? response.pagination.total : null;

  // Unknown total => we CANNOT claim this is the whole set, so we don't. Only
  // one direction of this flag is dangerous — reporting complete when it isn't
  // — and a short page is not proof of completeness either (an older server or
  // an intermediary could cap below the limit we asked for). Both mobile routes
  // send `pagination` on every response path today, so this branch should not
  // fire in practice; when it does, warning is the safe answer.
  const truncated = total === null || rows.length < total;
  return { rows, total, truncated };
}

/**
 * Fetch a page of devices.
 *
 * `orgId` is pushed to the server so a scoped view selects that org's machines
 * rather than filtering a page drawn from the whole fleet — an org whose
 * machines sat below the cut rendered as empty.
 */
export async function getDevicesPaged(orgId?: string | null): Promise<PagedResult<Device>> {
  const { rows, total, truncated } = await fetchPage<MobileDeviceRecord>((params) => {
    if (orgId) params.set('orgId', orgId);
    return `/devices?${params.toString()}`;
  }, DEVICE_PAGE_LIMIT);

  if (truncated) {
    Sentry.captureMessage('device list is showing a partial fleet', {
      level: 'warning',
      tags: { area: 'device-list' },
      extra: { returned: rows.length, total, pageLimit: DEVICE_PAGE_LIMIT },
    });
  }

  return { items: rows.map(mapDevice), total, truncated };
}

export async function getDevices(orgId?: string | null): Promise<Device[]> {
  return (await getDevicesPaged(orgId)).items;
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
