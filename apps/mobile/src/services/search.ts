import * as SecureStore from 'expo-secure-store';

import { getServerUrl } from './serverConfig';

const FALLBACK_API_BASE_URL = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:3001';
const API_PREFIX = '/api/v1/mobile';
const TOKEN_KEY = 'breeze_auth_token';

// Discriminated union mirrored from the API. Any new kind on the server
// must be added here AND in SearchSheet's kind-handling switch.
export type MobileSearchResult =
  | {
      kind: 'device';
      id: string;
      title: string;
      subtitle: string;
      meta: {
        orgId: string;
        siteId: string | null;
        hostname: string | null;
        displayName: string | null;
        osType: string | null;
        status: string | null;
        lastSeenAt: string | null;
        siteName: string | null;
      };
    }
  | {
      kind: 'alert';
      id: string;
      title: string;
      subtitle: string;
      meta: {
        orgId: string;
        severity: string;
        status: string;
        deviceId: string | null;
        deviceName: string | null;
        message: string | null;
        triggeredAt: string | null;
      };
    }
  | {
      kind: 'session';
      id: string;
      title: string;
      subtitle: string;
      meta: {
        orgId: string;
        status: string;
        turnCount: number;
        lastActivityAt: string | null;
        createdAt: string | null;
      };
    };

export interface MobileSearchResponse {
  results: MobileSearchResult[];
}

async function getToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(TOKEN_KEY);
  } catch {
    return null;
  }
}

/**
 * Cancellable search call. Caller passes an AbortSignal so the hook can
 * cancel the previous in-flight request before issuing a new one as the
 * user keeps typing. Aborted requests reject with a DOMException whose
 * name is 'AbortError' — useSearch swallows that case.
 */
export async function searchAll(
  q: string,
  limit: number,
  signal?: AbortSignal,
): Promise<MobileSearchResponse> {
  const trimmed = q.trim();
  if (!trimmed) {
    return { results: [] };
  }

  const baseUrl = (await getServerUrl()) || FALLBACK_API_BASE_URL;
  const token = await getToken();
  const params = new URLSearchParams({ q: trimmed, limit: String(limit) });
  const url = `${baseUrl}${API_PREFIX}/search?${params.toString()}`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(url, {
    method: 'GET',
    headers,
    credentials: 'include',
    signal,
  });

  if (!res.ok) {
    let message = `searchAll failed: ${res.status}`;
    try {
      const body = await res.json();
      if (body && typeof body.error === 'string') message = body.error;
    } catch {
      /* keep generic message */
    }
    throw new Error(message);
  }

  const json: MobileSearchResponse = await res.json();
  return json;
}
