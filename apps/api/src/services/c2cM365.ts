/**
 * Microsoft 365 multi-tenant app support for C2C backup.
 *
 * When C2C_M365_CLIENT_ID + C2C_M365_CLIENT_SECRET are set in .env,
 * enables one-click admin consent flow instead of manual app registration.
 */

import { captureException } from './sentry';

// ── Platform config ────────────────────────────────────────────────────────

export interface C2cM365PlatformConfig {
  clientId: string;
  clientSecret: string;
}

/**
 * Returns the multi-tenant app credentials from env, or null if not configured.
 */
export function getPlatformConfig(): C2cM365PlatformConfig | null {
  const clientId = process.env.C2C_M365_CLIENT_ID?.trim();
  const clientSecret = process.env.C2C_M365_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

// ── Admin consent URL ──────────────────────────────────────────────────────

export function buildAdminConsentUrl(params: {
  clientId: string;
  state: string;
  redirectUri: string;
}): string {
  const url = new URL('https://login.microsoftonline.com/common/adminconsent');
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('state', params.state);
  return url.toString();
}

// ── Callback URI ───────────────────────────────────────────────────────────

export function getCallbackUri(): string {
  const base = (
    process.env.PUBLIC_URL ||
    process.env.PUBLIC_APP_URL ||
    process.env.DASHBOARD_URL ||
    'http://localhost:3000'
  ).replace(/\/$/, '');
  return `${base}/api/v1/c2c/m365/callback`;
}

export function getFrontendBaseUrl(): string {
  return (
    process.env.DASHBOARD_URL ||
    process.env.PUBLIC_APP_URL ||
    'http://localhost:4321'
  ).replace(/\/$/, '');
}

// ── Client credentials token acquisition ───────────────────────────────────

export interface TokenResult {
  accessToken: string;
  expiresIn: number;
}

/**
 * Acquire an access token via OAuth 2.0 client_credentials grant.
 * Uses the platform app credentials + customer tenant ID.
 */
export async function acquireClientCredentialsToken(params: {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
}): Promise<TokenResult> {
  const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(params.tenantId)}/oauth2/v2.0/token`;

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: params.clientId,
    client_secret: params.clientSecret,
    scope: params.scope ?? 'https://graph.microsoft.com/.default',
  });

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const errBody = await res.text();
    console.error('[c2cM365] Token acquisition failed', {
      status: res.status,
      tenantId: params.tenantId,
      responseBody: errBody,
    });
    // Sanitize error — don't leak Azure AD error bodies to users
    throw new Error(
      res.status === 401
        ? 'Authentication failed — the app may not have consent for this tenant'
        : `Token acquisition failed (HTTP ${res.status})`
    );
  }

  const data = (await res.json()) as Record<string, unknown>;

  if (!data?.access_token || typeof data.access_token !== 'string' || typeof data.expires_in !== 'number') {
    console.error('[c2cM365] Unexpected token response shape', { keys: Object.keys(data) });
    throw new Error('Unexpected token response format from Azure AD');
  }

  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in,
  };
}

// ── Graph API access test ──────────────────────────────────────────────────

export async function testGraphAccess(
  accessToken: string
): Promise<{ ok: boolean; orgDisplayName?: string; error?: string }> {
  try {
    const res = await fetch('https://graph.microsoft.com/v1.0/organization', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) {
      const errBody = await res.text();
      console.warn('[c2cM365] Graph API test failed', { status: res.status, body: errBody.slice(0, 500) });
      return { ok: false, error: `Graph API returned ${res.status}` };
    }

    const data = (await res.json()) as {
      value?: Array<{ displayName?: string }>;
    };

    const orgName = data.value?.[0]?.displayName;
    return { ok: true, orgDisplayName: orgName };
  } catch (err) {
    console.error('[c2cM365] Graph API test error', { error: err instanceof Error ? err.message : String(err) });
    captureException(err);
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Graph API test failed',
    };
  }
}

// ── Token refresh helper ───────────────────────────────────────────────────

/**
 * Ensures a fresh access token for a platform_app connection.
 * Returns the current token if still valid, otherwise acquires a new one.
 */
export async function ensureFreshToken(params: {
  tenantId: string;
  currentToken: string | null;
  tokenExpiresAt: Date | null;
}): Promise<TokenResult | null> {
  const config = getPlatformConfig();
  if (!config) {
    console.warn('[c2cM365] ensureFreshToken called but C2C_M365_CLIENT_ID/C2C_M365_CLIENT_SECRET are not set');
    return null;
  }

  const bufferMs = 5 * 60 * 1000; // 5 minute buffer
  const isExpired =
    !params.currentToken ||
    !params.tokenExpiresAt ||
    params.tokenExpiresAt.getTime() - Date.now() < bufferMs;

  if (!isExpired) {
    return {
      accessToken: params.currentToken!,
      expiresIn: Math.floor((params.tokenExpiresAt!.getTime() - Date.now()) / 1000),
    };
  }

  return acquireClientCredentialsToken({
    tenantId: params.tenantId,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
  });
}
