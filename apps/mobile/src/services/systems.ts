import * as SecureStore from 'expo-secure-store';

import { getServerUrl } from './serverConfig';

const FALLBACK_API_BASE_URL = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:3001';
const TOKEN_KEY = 'breeze_auth_token';

export interface MobileSummary {
  devices: { total: number; online: number; offline: number; maintenance: number };
  alerts: {
    total: number;
    active: number;
    acknowledged: number;
    resolved: number;
    critical: number;
  };
}

async function getToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(TOKEN_KEY);
  } catch {
    return null;
  }
}

async function authedGet<T>(path: string, errLabel: string): Promise<T> {
  const baseUrl = (await getServerUrl()) || FALLBACK_API_BASE_URL;
  const token = await getToken();
  const url = `${baseUrl}${path}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(url, { headers, credentials: 'include' });
  if (!res.ok) throw new Error(`${errLabel} failed: ${res.status}`);
  return res.json();
}

// Calls GET /api/v1/mobile/summary. Returns aggregate counts that drive
// the Systems tab hero and breakdown bar.
export async function getMobileSummary(): Promise<MobileSummary> {
  return authedGet<MobileSummary>('/api/v1/mobile/summary', 'getMobileSummary');
}

export interface OrganizationSummary {
  id: string;
  name: string;
}

// Calls GET /api/v1/orgs/organizations. Used by the Systems tab to map
// orgIds (carried on alert + device records) to friendly names.
export async function listOrganizations(): Promise<OrganizationSummary[]> {
  const json = await authedGet<{ data: Array<{ id: string; name: string }> }>(
    '/api/v1/orgs/organizations?limit=200',
    'listOrganizations',
  );
  return json.data.map((o) => ({ id: o.id, name: o.name }));
}
