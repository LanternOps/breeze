import * as SecureStore from 'expo-secure-store';

const API_BASE_URL = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:3000';
const API_PREFIX = '/api/v1/mobile';
const API_CORE_PREFIX = '/api/v1';

// Types
export interface Alert {
  id: string;
  title: string;
  message: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
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
    const error: ApiError = await response.json().catch(() => ({
      message: 'An error occurred',
      statusCode: response.status,
    }));
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

// Auth API
export async function login(email: string, password: string): Promise<LoginResponse> {
  return request<LoginResponse>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

export async function logout(): Promise<void> {
  try {
    await request('/auth/logout', { method: 'POST' });
  } catch {
    // Ignore logout errors
  }
}

export async function refreshToken(): Promise<{ token: string }> {
  return request<{ token: string }>('/auth/refresh', {
    method: 'POST',
  });
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  await requestWithPrefix('/auth/change-password', API_CORE_PREFIX, {
    method: 'POST',
    body: JSON.stringify({ currentPassword, newPassword }),
  });
}

// Alerts API
export async function getAlerts(): Promise<Alert[]> {
  return request<Alert[]>('/alerts');
}

export async function getAlert(id: string): Promise<Alert> {
  return request<Alert>(`/alerts/${id}`);
}

export async function acknowledgeAlert(id: string): Promise<Alert> {
  return request<Alert>(`/alerts/${id}/acknowledge`, {
    method: 'POST',
  });
}

export async function getAlertStats(): Promise<{
  total: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  acknowledged: number;
}> {
  return request('/alerts/stats');
}

// Devices API
export async function getDevices(): Promise<Device[]> {
  return request<Device[]>('/devices');
}

export async function getDevice(id: string): Promise<Device> {
  return request<Device>(`/devices/${id}`);
}

export async function getDeviceMetrics(id: string): Promise<Device['metrics']> {
  return request<Device['metrics']>(`/devices/${id}/metrics`);
}

export async function sendDeviceAction(
  deviceId: string,
  action: DeviceAction
): Promise<{ id: string; type: DeviceAction }> {
  return requestWithPrefix(`/devices/${deviceId}/commands`, API_CORE_PREFIX, {
    method: 'POST',
    body: JSON.stringify({ type: action, payload: {} }),
  });
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
  return request<User>('/users/me');
}

export async function updateUserProfile(data: Partial<User>): Promise<User> {
  return request<User>('/users/me', {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}
