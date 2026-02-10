/**
 * Parse breeze:// deep link URLs
 * Format: breeze://connect?session=xxx&code=xxx&api=xxx
 */
export interface ConnectionParams {
  sessionId: string;
  connectCode: string;
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
    const connectCode = parsed.searchParams.get('code');
    const apiUrl = parsed.searchParams.get('api');

    if (!sessionId || !connectCode || !apiUrl) {
      return null;
    }

    return { sessionId, connectCode, apiUrl };
  } catch {
    return null;
  }
}

/**
 * Build the WebSocket URL for a desktop session
 */
export function buildWsUrl(apiUrl: string, sessionId: string, ticket: string): string {
  const wsBase = apiUrl.replace(/^http/, 'ws');
  return `${wsBase}/api/v1/desktop-ws/${sessionId}/ws?ticket=${encodeURIComponent(ticket)}`;
}
