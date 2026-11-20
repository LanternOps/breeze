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
): Promise<{ accessToken: string; expiresInSeconds: number; hostname?: string | null; osType?: string | null } | null> {
  const resp = await fetch(buildApiUrl(apiUrl, '/api/v1/desktop-ws/connect/exchange'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, code }),
  });

  if (!resp.ok) return null;
  return resp.json();
}

export async function exchangeVncConnectCode(
  apiUrl: string,
  code: string,
): Promise<{ accessToken: string; expiresInSeconds: number; tunnelId: string; wsUrl: string; deviceId: string } | null> {
  try {
    const res = await fetch(buildApiUrl(apiUrl, `/api/v1/vnc-exchange/${encodeURIComponent(code)}`), {
      method: 'POST',
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function createDesktopWsTicket(
  apiUrl: string,
  token: string,
  sessionId: string
): Promise<string | null> {
  const resp = await apiFetch(
    apiUrl,
    `/api/v1/desktop-ws/${sessionId}/viewer/ws-ticket`,
    token,
    { method: 'POST' }
  );

  if (!resp.ok) return null;
  const body = await resp.json() as { ticket?: string };
  return typeof body.ticket === 'string' ? body.ticket : null;
}

export type EndDesktopSessionResult = 'ended' | 'already_ended' | 'failed';

/** How long a hang-up waits for End before closing anyway. */
export const END_DESKTOP_SESSION_TIMEOUT_MS = 2000;

/**
 * #11931: tell the API the technician hung up, so the session history records
 * `operator_ended` and not the `peer_disconnected` the agent's peer-drop report
 * would write. Viewer-token route: the viewer holds no user session, so it
 * cannot call `POST /remote/sessions/:id/end`.
 *
 * Best effort and bounded. It never throws, and it gives up after `timeoutMs`,
 * so a slow or unreachable API never holds the hang-up or the window close;
 * the session then still ends, as `peer_disconnected`. A 400 means another
 * writer ended it first, which is also done.
 */
export async function endDesktopSession(
  apiUrl: string,
  token: string,
  sessionId: string,
  timeoutMs: number = END_DESKTOP_SESSION_TIMEOUT_MS,
): Promise<EndDesktopSessionResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await apiFetch(
      apiUrl,
      `/api/v1/desktop-ws/${encodeURIComponent(sessionId)}/viewer/end`,
      token,
      { method: 'POST', signal: controller.signal },
    );
    if (resp.ok) return 'ended';
    if (resp.status === 400) return 'already_ended';
    console.warn(`End session request was refused (HTTP ${resp.status}); the session will end when the connection closes.`);
    return 'failed';
  } catch (err) {
    console.warn('End session request failed; the session will end when the connection closes:', err);
    return 'failed';
  } finally {
    clearTimeout(timer);
  }
}
