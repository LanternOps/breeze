import { TAURI_ORIGINS } from './corsOrigins';

/**
 * Where a viewer token was exchanged, from the request `Origin` at
 * `POST /desktop-ws/connect/exchange`. Informational only: audit details and
 * reports, never an authorization input. A non-browser client can send any
 * `Origin`, and a token handed to another program keeps its original label.
 */
export type ExchangeOrigin = 'browser' | 'viewer' | 'unknown';

// The dashboard's own origin, not the CORS allowlist (which may hold other
// origins). PUBLIC_APP_URL then DASHBOARD_URL is the precedence passkeys.ts and
// config/tunnelOrigin.ts already use for "the web app's origin".
function dashboardOrigin(): string | null {
  const raw = (process.env.PUBLIC_APP_URL || process.env.DASHBOARD_URL)?.trim();
  if (!raw) return null;
  try {
    const { origin } = new URL(raw);
    // A value with no http(s) scheme (`localhost:4321`) parses to the opaque
    // origin "null", which must never match a `null` Origin header.
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

export function classifyExchangeOrigin(origin: string | undefined): ExchangeOrigin {
  if (!origin) return 'unknown';
  if (origin === dashboardOrigin()) return 'browser';
  return (TAURI_ORIGINS as readonly string[]).includes(origin) ? 'viewer' : 'unknown';
}
