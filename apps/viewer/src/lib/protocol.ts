/**
 * Parse breeze:// deep link URLs
 * Format: breeze://connect?session=xxx&code=xxx&api=xxx
 */
export interface ConnectionParams {
  sessionId: string;
  connectCode: string;
  apiUrl: string;
}

function isPrivateHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1' ||
    hostname.startsWith('10.') ||
    hostname.startsWith('192.168.') ||
    hostname.startsWith('100.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
  );
}

function joinPaths(basePath: string, path: string): string {
  const base = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
  const extra = path.startsWith('/') ? path : `/${path}`;
  if (base === '' || base === '/') return extra;
  return `${base}${extra}`;
}

export function parseDeepLink(url: string): ConnectionParams | null {
  try {
    // Normalize various URL formats that macOS/Windows/Linux may deliver:
    //   breeze://connect?...   (standard)
    //   breeze:connect?...     (some platforms strip //)
    //   breeze://connect/?...  (trailing slash variant)
    let normalized = url;
    if (normalized.startsWith('breeze://')) {
      normalized = normalized.replace('breeze://', 'https://breeze/');
    } else if (normalized.startsWith('breeze:')) {
      normalized = normalized.replace('breeze:', 'https://breeze/');
    }

    const parsed = new URL(normalized);
    const sessionId = parsed.searchParams.get('session');
    const connectCode = parsed.searchParams.get('code');
    const apiUrl = parsed.searchParams.get('api');

    if (!sessionId || !connectCode || !apiUrl) {
      return null;
    }

    // Validate apiUrl — require https, or allow http for private/loopback (dev/LAN).
    const api = new URL(apiUrl.trim());
    if (api.protocol !== 'https:' && api.protocol !== 'http:') {
      return null;
    }
    if (api.protocol === 'http:' && !isPrivateHost(api.hostname)) {
      return null;
    }

    return { sessionId, connectCode, apiUrl: api.toString().replace(/\/$/, '') };
  } catch {
    return null;
  }
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
