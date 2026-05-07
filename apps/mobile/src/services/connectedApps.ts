import * as SecureStore from 'expo-secure-store';

import { getServerUrl } from './serverConfig';
import { getOrCreateInstallationId } from './installationId';
import { MOBILE_DEVICE_ID_HEADER } from './api';

const FALLBACK_API_BASE_URL = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:3001';
const TOKEN_KEY = 'breeze_auth_token';
const CSRF_HEADER_NAME = 'x-breeze-csrf';

export interface ConnectedApp {
  clientId: string;
  displayName: string;
  createdAt: string;
  lastUsedAt: string | null;
  lastApprovalDecidedAt: string | null;
  revokedAt: string | null;
}

interface ApiError {
  message: string;
  code?: string;
  statusCode?: number;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const baseUrl = (await getServerUrl()) || FALLBACK_API_BASE_URL;
  const token = await SecureStore.getItemAsync(TOKEN_KEY).catch(() => null);
  const installationId = await getOrCreateInstallationId();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((init.headers as Record<string, string>) || {}),
    [MOBILE_DEVICE_ID_HEADER]: installationId,
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (init.method && init.method.toUpperCase() !== 'GET') {
    headers[CSRF_HEADER_NAME] = '1';
  }

  const res = await fetch(`${baseUrl}/api/v1${path}`, {
    ...init,
    headers,
    credentials: 'include',
  });

  if (res.status === 204) return undefined as T;

  if (!res.ok) {
    const body = await res.json().catch(() => ({} as Record<string, unknown>));
    const err: ApiError = {
      message: (typeof body.error === 'string' && body.error) || 'Request failed',
      code: typeof body.code === 'string' ? body.code : undefined,
      statusCode: res.status,
    };
    throw err;
  }

  const text = await res.text();
  return text ? (JSON.parse(text) as T) : ({} as T);
}

export async function listConnectedApps(): Promise<ConnectedApp[]> {
  const data = await call<{ clients: ConnectedApp[] }>('/me/oauth-clients');
  return data.clients ?? [];
}

export async function revokeConnectedApp(clientId: string, reason?: string): Promise<void> {
  await call<void>(
    `/me/oauth-clients/${encodeURIComponent(clientId)}/revoke`,
    {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }
  );
}
