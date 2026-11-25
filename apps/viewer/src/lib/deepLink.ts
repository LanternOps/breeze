import type { ConnectionParams, DesktopConnectionParams, VncConnectionParams } from '@breeze/remote-desktop-ui';

/**
 * Parse breeze:// deep link URLs
 * Format: breeze://connect?session=xxx&code=xxx&api=xxx
 *         breeze://vnc?tunnel=xxx&device=xxx&api=xxx&code=xxx
 */

function isLocalhost(host: string): boolean {
  const normalized = host.toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '[::1]'
  );
}

function validateApiUrl(apiUrl: string): string | null {
  const api = new URL(apiUrl.trim());
  if (api.protocol !== 'https:' && api.protocol !== 'http:') {
    return null;
  }
  if (api.protocol === 'http:' && !isLocalhost(api.hostname)) {
    return null;
  }
  return api.toString().replace(/\/$/, '');
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

    // Extract path segment: e.g. "vnc", "connect", or "" for breeze://?...
    const pathSegment = parsed.pathname.replace(/^\//, '').replace(/\/$/, '');

    if (pathSegment === 'vnc') {
      return parseVncDeepLink(parsed);
    }

    // Default: desktop connect flow (pathSegment === 'connect' or '')
    return parseDesktopDeepLink(parsed);
  } catch {
    return null;
  }
}

function parseDesktopDeepLink(parsed: URL): DesktopConnectionParams | null {
  const sessionId = parsed.searchParams.get('session');
  const connectCode = parsed.searchParams.get('code');
  const apiUrl = parsed.searchParams.get('api');
  const targetSessionIdRaw = parsed.searchParams.get('targetSessionId');
  const deviceIdRaw = parsed.searchParams.get('device');

  if (!sessionId || !connectCode || !apiUrl) {
    return null;
  }

  // Validate apiUrl: require https, or allow http for private/loopback (dev/LAN).
  let validatedApiUrl: string | null;
  try {
    validatedApiUrl = validateApiUrl(apiUrl);
  } catch {
    return null;
  }
  if (!validatedApiUrl) {
    return null;
  }

  // Parse optional targetSessionId (Windows session ID for RDP/console targeting)
  let targetSessionId: number | undefined;
  if (targetSessionIdRaw != null) {
    const parsed_id = parseInt(targetSessionIdRaw, 10);
    if (!isNaN(parsed_id) && parsed_id >= 0 && parsed_id <= 65535) {
      targetSessionId = parsed_id;
    }
  }

  // Parse optional deviceId
  const deviceId = deviceIdRaw && deviceIdRaw.length > 0 ? deviceIdRaw : undefined;

  return {
    mode: 'desktop',
    sessionId,
    connectCode,
    apiUrl: validatedApiUrl,
    ...(targetSessionId != null ? { targetSessionId } : {}),
    ...(deviceId != null ? { deviceId } : {}),
  };
}

function parseVncDeepLink(parsed: URL): VncConnectionParams | null {
  const tunnelId = parsed.searchParams.get('tunnel');
  const deviceId = parsed.searchParams.get('device');
  const apiUrl = parsed.searchParams.get('api');
  const code = parsed.searchParams.get('code');

  if (!tunnelId || !deviceId || !apiUrl || !code) {
    return null;
  }

  // Validate apiUrl, same rule as desktop (https required, or http only for loopback hosts)
  let validatedApiUrl: string | null;
  try {
    validatedApiUrl = validateApiUrl(apiUrl);
  } catch {
    return null;
  }
  if (!validatedApiUrl) {
    return null;
  }

  return {
    mode: 'vnc',
    tunnelId,
    deviceId,
    apiUrl: validatedApiUrl,
    code,
  };
}
