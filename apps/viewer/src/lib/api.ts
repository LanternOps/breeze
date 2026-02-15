/**
 * Simple fetch wrapper with Bearer token auth for Breeze API
 */

function joinPaths(basePath: string, path: string): string {
  const base = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
  const extra = path.startsWith('/') ? path : `/${path}`;
  if (base === '' || base === '/') return extra;
  return `${base}${extra}`;
}

function buildApiUrl(apiUrl: string, path: string): string {
  const u = new URL(apiUrl);
  u.pathname = joinPaths(u.pathname, path);
  u.search = '';
  u.hash = '';
  return u.toString();
}

export async function apiFetch(
  apiUrl: string,
  path: string,
  token: string,
  options: RequestInit = {}
): Promise<Response> {
  const url = buildApiUrl(apiUrl, path);
  return fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      ...options.headers,
    },
  });
}

/**
 * Create a desktop session via the API
 */
export async function createDesktopSession(
  apiUrl: string,
  token: string,
  deviceId: string
): Promise<{ id: string } | null> {
  const resp = await apiFetch(apiUrl, '/api/v1/remote/sessions', token, {
    method: 'POST',
    body: JSON.stringify({
      deviceId,
      type: 'desktop',
    }),
  });

  if (!resp.ok) return null;
  return resp.json();
}

export async function exchangeDesktopConnectCode(
  apiUrl: string,
  sessionId: string,
  code: string
): Promise<{ accessToken: string; expiresInSeconds: number } | null> {
  const resp = await fetch(buildApiUrl(apiUrl, '/api/v1/desktop-ws/connect/exchange'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, code }),
  });

  if (!resp.ok) return null;
  return resp.json();
}

export async function createDesktopWsTicket(
  apiUrl: string,
  token: string,
  sessionId: string
): Promise<string | null> {
  const resp = await apiFetch(
    apiUrl,
    `/api/v1/remote/sessions/${sessionId}/ws-ticket`,
    token,
    { method: 'POST' }
  );

  if (!resp.ok) return null;
  const body = await resp.json() as { ticket?: string };
  return typeof body.ticket === 'string' ? body.ticket : null;
}
