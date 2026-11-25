/**
 * Connection parameters and the WebSocket URL builder. Deep link parsing stays in
 * the native viewer, so no host other than the viewer can import it from here.
 */

export interface DesktopConnectionParams {
  mode: 'desktop';
  sessionId: string;
  connectCode: string;
  apiUrl: string;
  targetSessionId?: number;
  deviceId?: string;
}

export interface VncConnectionParams {
  mode: 'vnc';
  tunnelId: string;
  deviceId: string;
  apiUrl: string;
  code: string;
}

export type ConnectionParams = DesktopConnectionParams | VncConnectionParams;

function joinPaths(basePath: string, path: string): string {
  const base = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
  const extra = path.startsWith('/') ? path : `/${path}`;
  if (base === '' || base === '/') return extra;
  return `${base}${extra}`;
}

/**
 * Build the WebSocket URL for a desktop session
 */
export function buildWsUrl(apiUrl: string, sessionId: string, ticket: string): string {
  const u = new URL(apiUrl);
  if (u.protocol === 'https:') u.protocol = 'wss:';
  else if (u.protocol === 'http:') u.protocol = 'ws:';
  else throw new Error(`Unsupported API protocol for WebSocket: ${u.protocol}`);

  u.pathname = joinPaths(u.pathname, `/api/v1/desktop-ws/${sessionId}/ws`);
  u.search = new URLSearchParams({ ticket }).toString();
  u.hash = '';
  return u.toString();
}
