/**
 * Parse breeze:// deep link URLs
 * Format: breeze://connect?session=xxx&token=xxx&api=xxx
 */
export interface ConnectionParams {
  sessionId: string;
  token: string;
  apiUrl: string;
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
    const token = parsed.searchParams.get('token');
    const apiUrl = parsed.searchParams.get('api');

    if (!sessionId || !token || !apiUrl) {
      console.warn('[parseDeepLink] Missing params from URL:', url,
        { sessionId: !!sessionId, token: !!token, apiUrl: !!apiUrl });
      return null;
    }

    return { sessionId, token, apiUrl };
  } catch (e) {
    console.error('[parseDeepLink] Failed to parse URL:', url, e);
    return null;
  }
}

/**
 * Build the WebSocket URL for a desktop session
 */
export function buildWsUrl(params: ConnectionParams): string {
  const { apiUrl, sessionId, token } = params;
  const wsBase = apiUrl.replace(/^http/, 'ws');
  return `${wsBase}/api/v1/desktop-ws/${sessionId}/ws?token=${encodeURIComponent(token)}`;
}
