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
    // Handle both breeze://connect?... and breeze:connect?... formats
    const normalized = url.replace('breeze://', 'https://breeze/');
    const parsed = new URL(normalized);
    const sessionId = parsed.searchParams.get('session');
    const token = parsed.searchParams.get('token');
    const apiUrl = parsed.searchParams.get('api');

    if (!sessionId || !token || !apiUrl) {
      return null;
    }

    return { sessionId, token, apiUrl };
  } catch {
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
