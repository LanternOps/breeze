import * as SecureStore from 'expo-secure-store';

const API_BASE_URL = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:3001';
const API_PREFIX = '/api/v1/mobile';
const API_CORE_PREFIX = '/api/v1';

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
}

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
  error?: string;
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
  options: RequestInit = {}
): Promise<T> {
  const token = await getToken();

  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...options.headers,
  };

  if (token) {
    (headers as Record<string, string>)['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE_URL}${prefix}${endpoint}`, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({} as Record<string, unknown>));
    const error: ApiError = {
      message:
        (typeof body.error === 'string' && body.error)
        || (typeof body.message === 'string' && body.message)
        || 'An error occurred',
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
  options: RequestInit = {}
): Promise<T> {
  return requestWithPrefix<T>(endpoint, API_PREFIX, options);
}

export type DeviceAction = 'reboot' | 'shutdown' | 'lock' | 'wake' | 'update';

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
export async function login(email: string, password: string): Promise<LoginResponse> {
  const response = await requestWithPrefix<LoginPayload>('/auth/login', API_CORE_PREFIX, {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });

  if (response.mfaRequired) {
    throw { message: 'MFA is required for this account' } as ApiError;
  }

  const token = response.tokens?.accessToken || response.accessToken;
  if (!response.user || !token) {
    throw { message: response.error || 'Invalid login response' } as ApiError;
  }

  return {
    token,
    user: response.user
  };
}

export async function logout(): Promise<void> {
  try {
    await requestWithPrefix('/auth/logout', API_CORE_PREFIX, { method: 'POST' });
  } catch {
    // Ignore logout errors
  }
}

export async function refreshToken(): Promise<{ token: string }> {
  const currentToken = await getToken();
  if (!currentToken) {
    throw { message: 'No token available to refresh' } as ApiError;
  }

  const response = await requestWithPrefix<{ tokens?: AuthTokensPayload; accessToken?: string }>(
    '/auth/refresh',
    API_CORE_PREFIX,
    {
    method: 'POST',
    body: JSON.stringify({ refreshToken: currentToken })
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
export async function getAlerts(): Promise<Alert[]> {
  const response = await request<ListResponse<MobileAlertRecord>>('/alerts/inbox');
  return response.data.map(mapAlert);
}

export async function getAlert(id: string): Promise<Alert> {
  const response = await requestWithPrefix<MobileAlertRecord>(`/alerts/${id}`, API_CORE_PREFIX);
  return mapAlert(response);
}

export async function acknowledgeAlert(id: string): Promise<Alert> {
  const response = await request<MobileAlertRecord>(`/alerts/${id}/acknowledge`, {
    method: 'POST',
  });
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
export async function getDevices(): Promise<Device[]> {
  const response = await request<ListResponse<MobileDeviceRecord>>('/devices');
  return response.data.map(mapDevice);
}

export async function getDevice(id: string): Promise<Device> {
  const response = await requestWithPrefix<MobileDeviceRecord>(`/devices/${id}`, API_CORE_PREFIX);
  return mapDevice(response);
}

export async function getDeviceMetrics(id: string): Promise<Device['metrics']> {
  const response = await requestWithPrefix<{
    data?: Array<{
      avgCpuPercent?: number;
      avgRamPercent?: number;
      avgDiskPercent?: number;
    }>;
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
