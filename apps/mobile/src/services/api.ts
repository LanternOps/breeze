import * as SecureStore from 'expo-secure-store';
import * as Sentry from '@sentry/react-native';

import { getServerUrl } from './serverConfig';
import { getOrCreateInstallationId } from './installationId';
import { fetchWithTimeout } from './fetchWithTimeout';
import { currentTruncationEpoch, trackTruncation } from './truncationReporting';
import {
  applyCsrfSignal,
  forgetCsrfToken,
  getCsrfHeaderValue,
  readCsrfCookie,
} from './csrfToken';
import {
  commitIfCurrent,
  currentSessionGeneration,
} from './sessionGeneration';
import { beginSessionInvalidation } from './sessionAuthority';
import { noteServerDate } from './serverClock';
import { AUTH_TOKEN_KEY, NATIVE_AUTH_BINDING_KEY } from './authSessionKeys';
import { createTokenRefresher } from './tokenRefresh';

export const FALLBACK_API_BASE_URL =
  process.env.EXPO_PUBLIC_API_URL || 'http://localhost:3001';
const API_PREFIX = '/api/v1/mobile';
/** Exported so callers that build a raw URL (authenticated `<Image>` sources,
 *  file downloads) cannot drift from the prefix `coreRequest` itself uses. */
export const API_CORE_PREFIX = '/api/v1';
const CSRF_HEADER_NAME = 'x-breeze-csrf';
const CSRF_HEADER_VALUE = '1';
export const MOBILE_DEVICE_ID_HEADER = 'x-breeze-mobile-device-id';
export const NATIVE_AUTH_BINDING_HEADER = 'x-breeze-native-auth-binding';
export { NATIVE_AUTH_BINDING_KEY } from './authSessionKeys';
const AUTH_TRANSITION_HEADER = 'x-breeze-auth-transition';
const AUTH_TRANSITION_VERSION = 'v1';
export const DEVICE_BLOCKED_CODE = 'device_blocked';

const NATIVE_AUTH_ISSUER_ENDPOINTS = new Set([
  '/auth/login',
  '/auth/mfa/verify',
  '/auth/refresh',
]);

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
  /** Rule-template category (e.g. "Security", "Performance"); absent for
   * alerts created without a rule. */
  category?: string;
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

export type MfaMethod = 'totp' | 'sms' | 'passkey' | 'recovery';
export type MfaPrimaryMethod = Exclude<MfaMethod, 'recovery'>;

export interface MfaAllowedMethods {
  totp: boolean;
  sms: boolean;
  passkey: boolean;
}

export interface MfaChallenge {
  tempToken: string;
  mfaMethod: MfaMethod;
  methods: MfaMethod[];
  allowedMethods: MfaAllowedMethods;
  recoveryAvailable: boolean;
  phoneLast4: string | null;
}

export interface MfaEnrollmentRequired {
  reason: 'mfa_enrollment_required';
  enrollUrl: string;
}

export type LoginResult =
  | { kind: 'success'; token: string; user: User; registerGrant: string | null }
  | { kind: 'mfaRequired'; challenge: MfaChallenge }
  | { kind: 'mfaEnrollmentRequired'; handoff: MfaEnrollmentRequired };

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
  allowedMethods?: MfaAllowedMethods;
  recoveryAvailable?: boolean;
  passkeyAvailable?: boolean;
  phoneLast4?: string | null;
  mfaEnrollmentRequired?: boolean;
  enrollUrl?: string;
  error?: string;
  /** #2707: single-use approver-register grant; mobile-header-gated. */
  authenticatorRegisterGrantId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPrimaryMfaMethod(value: unknown): value is MfaPrimaryMethod {
  return value === 'totp' || value === 'sms' || value === 'passkey';
}

export function parseMfaChallengePayload(value: unknown): MfaChallenge | null {
  if (
    !isRecord(value)
    || value.mfaRequired !== true
    || typeof value.tempToken !== 'string'
    || !value.tempToken
    || !isPrimaryMfaMethod(value.mfaMethod)
  ) {
    return null;
  }
  const phoneLast4 = value.phoneLast4 === undefined || value.phoneLast4 === null
    ? null
    : typeof value.phoneLast4 === 'string' ? value.phoneLast4 : undefined;
  if (phoneLast4 === undefined) return null;
  const hasAllowed = Object.prototype.hasOwnProperty.call(value, 'allowedMethods');
  const hasRecovery = Object.prototype.hasOwnProperty.call(value, 'recoveryAvailable');
  if (hasAllowed !== hasRecovery) return null;

  if (!hasAllowed) {
    if (value.passkeyAvailable !== undefined && typeof value.passkeyAvailable !== 'boolean') return null;
    const allowedMethods: MfaAllowedMethods = {
      totp: value.mfaMethod === 'totp',
      sms: value.mfaMethod === 'sms',
      passkey: value.mfaMethod === 'passkey' || value.passkeyAvailable === true,
    };
    const methods: MfaMethod[] = [
      ...(allowedMethods.totp ? ['totp' as const] : []),
      ...(allowedMethods.sms ? ['sms' as const] : []),
      ...(allowedMethods.passkey ? ['passkey' as const] : []),
    ];
    return { tempToken: value.tempToken, mfaMethod: value.mfaMethod, methods, allowedMethods, recoveryAvailable: false, phoneLast4 };
  }

  const allowed = value.allowedMethods;
  if (
    !isRecord(allowed)
    || typeof allowed.totp !== 'boolean'
    || typeof allowed.sms !== 'boolean'
    || typeof allowed.passkey !== 'boolean'
    || typeof value.recoveryAvailable !== 'boolean'
    || typeof value.passkeyAvailable !== 'boolean'
    || value.passkeyAvailable !== allowed.passkey
  ) return null;
  const allowedMethods = { totp: allowed.totp, sms: allowed.sms, passkey: allowed.passkey };
  const methods: MfaMethod[] = [
    ...(allowedMethods.totp ? ['totp' as const] : []),
    ...(allowedMethods.sms ? ['sms' as const] : []),
    ...(allowedMethods.passkey ? ['passkey' as const] : []),
    ...(value.recoveryAvailable ? ['recovery' as const] : []),
  ];
  if (methods.length === 0) return null;
  const mfaMethod = allowedMethods[value.mfaMethod] ? value.mfaMethod : methods[0];
  if (!mfaMethod) return null;
  return { tempToken: value.tempToken, mfaMethod, methods, allowedMethods, recoveryAvailable: value.recoveryAvailable, phoneLast4 };
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
  /**
   * The rule's alert-template category, joined server-side (#4535). Alerts
   * created without a rule carry no category, hence nullable rather than
   * always-present.
   */
  category?: string | null;
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
async function getToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(AUTH_TOKEN_KEY);
  } catch {
    return null;
  }
}

/**
 * `body instanceof FormData`, guarded for runtimes that lack the global.
 *
 * React Native ships its own FormData polyfill and Node 22 has undici's, so the
 * global exists on both paths we run on — but a bare `instanceof` against a
 * missing global is a ReferenceError that would take down every request, not
 * just uploads.
 */
function isFormData(body: BodyInit | null | undefined): boolean {
  return typeof FormData !== 'undefined' && body instanceof FormData;
}

/**
 * Auth headers for a component that fetches bytes itself rather than through
 * `coreRequest` — `<Image source={{ uri, headers }}>` over the authenticated
 * attachment content route, which is never a presigned public URL.
 *
 * Deliberately NOT the full request header set: there is no CSRF header (these
 * are GETs) and no native binding (not an auth-issuer endpoint). Authorization
 * is omitted entirely when no token is stored, because a literal
 * `Bearer null` reads as a malformed credential rather than an absent one.
 */
export async function getAuthImageHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  const token = await getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const installationId = await getOrCreateInstallationId();
    if (installationId) headers[MOBILE_DEVICE_ID_HEADER] = installationId;
  } catch {
    // Deliberately silent, unlike the request path above, which reports the
    // same failure to Sentry. This runs once per rendered thumbnail rather
    // than once per request, so reporting here would send one event per tile
    // per feed render and bury the signal the request path already carries.
    // The header is diagnostic, not authority — dropping it costs nothing.
  }
  return headers;
}

// Request helper
/**
 * Whether a 401 on this request should be answered with a token refresh. Only
 * the auth endpoints are excluded: a 401 from /auth/login is bad credentials,
 * and /auth/refresh must never trigger itself. /auth/me is a normal session
 * probe (cold-start revalidation) and does refresh.
 */
function canRefreshFor(prefix: string, endpoint: string): boolean {
  if (prefix !== API_CORE_PREFIX) return true;
  const path = endpoint.split('?')[0];
  return !path.startsWith('/auth/') || path === '/auth/me';
}


async function requestWithPrefix<T>(
  endpoint: string,
  prefix: string,
  options: RequestInit = {},
  timeoutMs?: number,
  sessionContext: Readonly<{
    capturedGeneration?: number;
    bearerToken?: string | null;
  }> = {},
): Promise<T> {
  // This must be the first operation: even server URL discovery can block on
  // storage, and a logout during that await must supersede this request.
  const capturedGeneration = sessionContext.capturedGeneration
    ?? currentSessionGeneration();
  const baseUrl = (await getServerUrl()) || FALLBACK_API_BASE_URL;
  assertCurrentSession(capturedGeneration);
  const url = `${baseUrl}${prefix}${endpoint}`;
  const nativeAuthIssuer = prefix === API_CORE_PREFIX
    && NATIVE_AUTH_ISSUER_ENDPOINTS.has(endpoint);
  let retriedBindingBootstrap = false;
  // One refresh-and-retry per request. Set by the 401 branch below; the token
  // read prefers it so the retry cannot race a slow keychain write and re-send
  // the token that just expired.
  let retriedAuth = false;
  let refreshedToken: string | null = null;

  while (true) {
    assertCurrentSession(capturedGeneration);
    const token = refreshedToken
      ?? (Object.prototype.hasOwnProperty.call(sessionContext, 'bearerToken')
        ? sessionContext.bearerToken ?? null
        : await getToken());
    const method = (options.method ?? 'GET').toUpperCase();
    const multipart = isFormData(options.body);
    const headers: Record<string, string> = {
      // Multipart is the one body kind we must NOT name: the runtime generates a
      // per-request boundary and writes `multipart/form-data; boundary=…` itself.
      // A hand-set value has no boundary, so the server parses zero parts and the
      // upload fails with a confusing 400 rather than an obvious one.
      ...(multipart ? {} : { 'Content-Type': 'application/json' }),
      ...(options.headers as Record<string, string> | undefined),
    };

    // Strip it case-insensitively rather than merely declining to add it. A
    // caller passing its own `Content-Type` alongside FormData is always wrong
    // (see above) and the spread would let it back in.
    if (multipart) {
      for (const name of Object.keys(headers)) {
        if (name.toLowerCase() === 'content-type') delete headers[name];
      }
    }

    if (token) headers.Authorization = `Bearer ${token}`;

    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      // Echo the server's double-submit token. Sending the fixed bootstrap value
      // once the CSRF cookie exists fails `safeCompareTokens` server-side and
      // rejects every refresh, which ends the session at the access-token TTL.
      headers[CSRF_HEADER_NAME] = await getCsrfHeaderValue();
    }

    // Always send the per-install id so the API can recognise this phone. This
    // selects native transport but is not accepted by the server as binding
    // authority; only the signed native binding below carries authority.
    try {
      const installationId = await getOrCreateInstallationId();
      if (installationId) headers[MOBILE_DEVICE_ID_HEADER] = installationId;
    } catch (e) {
      Sentry.captureMessage('installation id unavailable for mobile-device header', {
        level: 'warning',
        tags: { area: 'mobile-device-id-header' },
        extra: { errorName: (e as Error)?.name ?? 'unknown' },
      });
    }

    if (nativeAuthIssuer) {
      headers[AUTH_TRANSITION_HEADER] = AUTH_TRANSITION_VERSION;
      const binding = await SecureStore.getItemAsync(NATIVE_AUTH_BINDING_KEY).catch(() => null);
      if (binding) headers[NATIVE_AUTH_BINDING_HEADER] = binding;
    }

    assertCurrentSession(capturedGeneration);
    const response = await fetchWithTimeout(
      url,
      { ...options, headers, credentials: 'include' },
      timeoutMs
    );
    // Anchor the server clock from every response, INCLUDING failures: a phone
    // whose clock runs fast has its offline time entries rejected as too far in
    // the future (createTimeEntrySchema refines startedAt with notFarFuture),
    // and that 400 is permanent. Synchronous, never throws.
    noteServerDate(response.headers.get('date'));
    assertCurrentSession(capturedGeneration);

    if (nativeAuthIssuer && response.status === 428 && !retriedBindingBootstrap) {
      retriedBindingBootstrap = true;
      const replacement = response.headers.get(NATIVE_AUTH_BINDING_HEADER)?.trim();
      if (replacement) {
        const committed = await commitIfCurrent(capturedGeneration, async () => {
          await SecureStore.setItemAsync(NATIVE_AUTH_BINDING_KEY, replacement, {
            keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
          });
          return replacement;
        });
        assertCurrentSession(capturedGeneration);
        if (committed !== undefined) {
          assertCurrentSession(capturedGeneration);
          continue;
        }
      }
    }

    // Every response-derived write is session-owned. A delayed ordinary API
    // response can be just as stale as an issuer response after account switch.
    const applyCsrf = () => applyCsrfSignal(readCsrfCookie(response.headers.get('set-cookie')));
    await commitIfCurrent(capturedGeneration, applyCsrf);
    assertCurrentSession(capturedGeneration);

    if (!response.ok) {
      const body = await response.json().catch(() => ({} as Record<string, unknown>));
      assertCurrentSession(capturedGeneration);
      // Access tokens live JWT_EXPIRES_IN (15 minutes in production) and the
      // refresh cookie lives days. Until this branch existed only the AI chat
      // path refreshed, so every other screen hard-401'd a quarter of an hour
      // after sign-in and the cold-start revalidation then signed the user
      // out. Refresh once and replay; a second 401 is final. The auth
      // endpoints themselves are excluded so /auth/refresh can never recurse.
      if (
        response.status === 401
        && !retriedAuth
        && token
        && canRefreshFor(prefix, endpoint)
      ) {
        retriedAuth = true;
        const fresh = await refreshAccessToken();
        assertCurrentSession(capturedGeneration);
        if (fresh) {
          refreshedToken = fresh;
          continue;
        }
      }
      const code = typeof body.code === 'string' ? body.code : undefined;
      if (code === DEVICE_BLOCKED_CODE) {
        const reason = typeof body.reason === 'string' ? body.reason : null;
        notifyDeviceBlocked(reason);
      }
      assertCurrentSession(capturedGeneration);
    // Self-heal a token the server will not accept. The stored value can
    // outlive its cookie — SecureStore survives an iOS reinstall while the
    // cookie jar does not — and if `set-cookie` is not readable on this runtime
    // we would never have learned a good one. Forgetting it makes the next
    // request bootstrap with the literal the no-cookie path accepts, so the
    // client recovers instead of looping.
      const message =
        (typeof body.error === 'string' && body.error)
        || (typeof body.message === 'string' && body.message)
        || 'An error occurred';
      if (/csrf/i.test(message)) {
        await commitIfCurrent(capturedGeneration, forgetCsrfToken);
        assertCurrentSession(capturedGeneration);
      }

      const error: ApiError = { message, code, statusCode: response.status };
      throw error;
    }

    const text = await response.text();
    assertCurrentSession(capturedGeneration);
    if (!text) return {} as T;

    return JSON.parse(text);
  }
}

function assertCurrentSession(capturedGeneration: number): void {
  if (capturedGeneration === currentSessionGeneration()) return;
  throw {
    message: 'Response belongs to a superseded session',
    code: 'session_superseded',
  } as ApiError;
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
    category: alert.category ?? undefined,
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

  // Fail closed even if a server accidentally includes tempting user/token
  // fields: enrollment-required is a handoff state, never authentication.
  if (response.mfaEnrollmentRequired === true) {
    return {
      kind: 'mfaEnrollmentRequired',
      handoff: {
        reason: 'mfa_enrollment_required',
        enrollUrl: typeof response.enrollUrl === 'string' && response.enrollUrl.startsWith('/')
          ? response.enrollUrl
          : '/auth/mfa/setup',
      },
    };
  }

  if (response.mfaRequired) {
    const challenge = parseMfaChallengePayload(response);
    if (!challenge) {
      throw { message: 'Invalid MFA challenge from server' } as ApiError;
    }
    return { kind: 'mfaRequired', challenge };
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

export async function verifyMfa(
  code: string,
  tempToken: string,
  method: Exclude<MfaMethod, 'passkey'>,
): Promise<LoginResponse> {
  const response = await requestWithPrefix<LoginPayload>('/auth/mfa/verify', API_CORE_PREFIX, {
    method: 'POST',
    body: JSON.stringify({ code, tempToken, method }),
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

export async function logout(
  options: Readonly<{
    sessionGenerationAlreadyAdvanced?: boolean;
    localCleanupAlreadyEnqueued?: boolean;
    bearerToken?: string | null;
  }> = {},
): Promise<void> {
  const invalidation = options.sessionGenerationAlreadyAdvanced
    ? null
    : beginSessionInvalidation();
  const logoutGeneration = invalidation?.generation ?? currentSessionGeneration();
  const networkLogout = requestWithPrefix(
    '/auth/logout',
    API_CORE_PREFIX,
    { method: 'POST' },
    undefined,
    {
      capturedGeneration: logoutGeneration,
      ...(options.bearerToken !== undefined ? { bearerToken: options.bearerToken } : {}),
    },
  );
  // Attach the rejection handler immediately; secure cleanup may be queued
  // behind a slow old-session write and must not leave an early network error
  // unhandled while we wait.
  const networkResult = networkLogout.then(
    () => undefined,
    () => undefined,
  );
  const cleanup = options.localCleanupAlreadyEnqueued
    ? Promise.resolve()
    : invalidation?.cleanup ?? commitIfCurrent(logoutGeneration, async () => {
      await Promise.all([
        SecureStore.deleteItemAsync(AUTH_TOKEN_KEY),
        SecureStore.deleteItemAsync(NATIVE_AUTH_BINDING_KEY),
        forgetCsrfToken(),
      ]);
    });

  // Cleanup is enqueued before waiting on the network. The request already
  // captured its generation and optional bearer synchronously above.
  try {
    await cleanup;
    await networkResult;
  } catch {
    // Ignore logout errors
  }
}

export async function refreshToken(): Promise<{ token: string }> {
  const generation = currentSessionGeneration();
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
  // Callers such as aiChat persist the returned token. Refuse to hand them a
  // response that began before logout advanced the generation, otherwise the
  // caller could reinstall access authority after local teardown completed.
  if (generation !== currentSessionGeneration()) {
    throw {
      message: 'Refresh response belongs to a superseded session',
      code: 'session_superseded',
    } as ApiError;
  }
  return { token };
}

/**
 * The app's single token refresher: the request core calls it on a 401 and
 * aiChat reopens its stream through it, so concurrent 401s share one
 * /auth/refresh. See tokenRefresh.ts for why it is built here.
 */
export const refreshAccessToken = createTokenRefresher(refreshToken);

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
  // Captured BEFORE the request: a result that arrives after a sign-out must
  // not repopulate the tracker for the next session.
  const epoch = currentTruncationEpoch();
  const { rows, total, truncated } = await fetchPage<MobileAlertRecord>((params) => {
    if (status === 'active') params.set('status', 'active');
    return `/alerts/inbox?${params.toString()}`;
  }, ALERT_PAGE_LIMIT);

  // Change-only, as above (#3783). Keyed per status: the active inbox and the
  // full history are different sets, and one being partial says nothing about
  // the other.
  const alertTruncation = trackTruncation(`alert-inbox:${status}`, total, rows.length, epoch);
  if (alertTruncation) {
    Sentry.captureMessage('alert inbox is showing a partial set', {
      level: 'warning',
      tags: { area: 'alert-inbox', truncation: alertTruncation },
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

export interface BulkAckOutcome {
  acknowledged: string[];
  failed: string[];
  /**
   * Ids whose outcome the client genuinely does not know: the request timed
   * out, the connection dropped, or the body was unusable. The server may well
   * have committed them.
   *
   * Kept SEPARATE from `failed` because the two demand opposite handling.
   * Acknowledging is irreversible, so restoring an unknown id as active invites
   * an operator to acknowledge it a second time; leaving it hidden until the
   * next authoritative fetch is the recoverable direction.
   */
  unknown: string[];
  /** One entry per failed id, in completion order, for the caller to report. */
  errors: unknown[];
}

/**
 * Acknowledge many alerts in ONE request.
 *
 * Was four workers draining an in-memory queue of per-alert calls, because
 * `POST /alerts/bulk` demanded `alerts:write` while Technicians are seeded
 * `alerts:acknowledge` only — so the batched form 403'd for exactly the people
 * who triage alerts from a phone. That is fixed server-side (#3727): bulk is
 * now gated per action, and a bulk acknowledge accepts `alerts:acknowledge`.
 *
 * Why one request matters beyond tidiness: the caller flushes this on
 * background, and iOS may suspend or reclaim the process moments later. A
 * queue leaves most of a batch unsent in memory where nothing can recover it —
 * the undo window has already released those ids, so the timer, later
 * lifecycle events and the unmount cleanup all correctly refuse to re-send
 * them. One dispatched request either lands whole or fails whole.
 *
 * Never rejects: the caller needs to know which ids landed so the rest can be
 * restored individually. `skipped` ids are alerts the server found in a
 * non-active state (already acknowledged, resolved elsewhere) — NOT failures,
 * and deliberately not restored, because the row should follow server truth on
 * the next fetch rather than reappear as active.
 */
export async function acknowledgeAlerts(ids: string[]): Promise<BulkAckOutcome> {
  if (ids.length === 0) return { acknowledged: [], failed: [], unknown: [], errors: [] };
  const requested = new Set(ids);
  try {
    const res = await coreRequest<{
      updated?: number;
      skipped?: number;
      failed?: number;
      updatedIds?: unknown;
      skippedIds?: unknown;
      failedIds?: unknown;
    }>(
      '/alerts/bulk',
      { method: 'POST', body: JSON.stringify({ action: 'acknowledge', alertIds: ids }) },
      // Same deadline the single-alert path uses. This is ONE request but the
      // server still processes the batch SERIALLY, so a large batch can outrun
      // it — which is why a timeout lands in `unknown`, not `failed`.
      ACKNOWLEDGE_TIMEOUT_MS,
    );

    // Trust the arrays only if they satisfy the contract. A server that is
    // older (counts only), newer, or simply wrong must not be able to make the
    // client restore rows it actually acknowledged.
    const asIds = (v: unknown): string[] | null =>
      Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null;
    const upd = asIds(res.updatedIds);
    const skp = asIds(res.skippedIds);
    const fld = asIds(res.failedIds);

    const seen = new Set<string>();
    const wellFormed =
      upd !== null && skp !== null && fld !== null &&
      // every returned id was requested, and appears exactly once overall
      [...upd, ...skp, ...fld].every((id) => requested.has(id) && !seen.has(id) && (seen.add(id), true)) &&
      // and the arrays account for the whole batch
      seen.size === requested.size;

    if (!wellFormed) {
      // Includes the counts-only server: it may have acknowledged everything,
      // so restoring would be wrong and claiming success would be a lie.
      return {
        acknowledged: [], failed: [], unknown: [...ids],
        errors: [new Error('bulk acknowledge: response did not account for the batch')],
      };
    }

    // `skipped` is not a failure — the alert was already out of `active` state,
    // so the row should follow server truth rather than reappear as active.
    const failed = fld;
    return {
      acknowledged: [...upd, ...skp],
      failed,
      unknown: [],
      errors: failed.length ? [new Error(`bulk acknowledge: ${failed.length} of ${ids.length} not acknowledged`)] : [],
    };
  } catch (err) {
    // A transport error proves only that WE did not get a usable response — a
    // 45s abort, a dropped connection or a truncated body can all sit on top of
    // a server that committed. Every id is therefore unknown, never failed.
    return { acknowledged: [], failed: [], unknown: [...ids], errors: [err] };
  }
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
  // See getAlertsPaged: captured before the request, checked after it resolves.
  const epoch = currentTruncationEpoch();
  const { rows, total, truncated } = await fetchPage<MobileDeviceRecord>((params) => {
    if (orgId) params.set('orgId', orgId);
    return `/devices?${params.toString()}`;
  }, DEVICE_PAGE_LIMIT);

  // Only on a CHANGE of truncation state: any tenant above the page limit is
  // permanently truncated, and this runs on mount, tab focus, pull-to-refresh,
  // push delivery and WS updates, so reporting every time buried the signal
  // under its own volume (#3783).
  // Keyed by orgId because it is sent to the SERVER above: a scoped fetch and
  // the unscoped fleet are different result sets, and one being partial says
  // nothing about the other. Sharing one key broke both ways — an org's first
  // partial was swallowed by the fleet's state, and a small complete org reset
  // the key so the unchanged fleet reported again on every return to Systems,
  // rebuilding the flood this fixes.
  const deviceTruncation = trackTruncation(
    `device-list:${orgId ?? 'all'}`,
    total,
    rows.length,
    epoch
  );
  if (deviceTruncation) {
    Sentry.captureMessage('device list is showing a partial fleet', {
      level: 'warning',
      tags: { area: 'device-list', truncation: deviceTruncation },
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
