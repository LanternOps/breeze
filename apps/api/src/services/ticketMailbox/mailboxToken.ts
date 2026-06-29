import { acquireClientCredentialsToken, isM365TenantId } from '../c2cM365';

interface CachedToken {
  token: string;
  expiresAt: number;
}

const cache = new Map<string, CachedToken>();
const FRESH_BUFFER_MS = 5 * 60 * 1000;

export function _clearMailboxTokenCache(): void {
  cache.clear();
}

export function getMailboxPlatformConfig(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.TICKET_MAILBOX_M365_CLIENT_ID?.trim();
  const clientSecret = process.env.TICKET_MAILBOX_M365_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export function getMailboxCallbackUri(): string {
  const base = (
    process.env.PUBLIC_URL ||
    process.env.PUBLIC_APP_URL ||
    process.env.DASHBOARD_URL ||
    'http://localhost:3000'
  ).replace(/\/$/, '');
  return `${base}/api/v1/tickets/mailbox/callback`;
}

/** App-only Graph token for a partner's tenant. Cached in-memory keyed by tenant. */
export async function getMailboxToken(tenantId: string): Promise<string> {
  if (!isM365TenantId(tenantId)) throw new Error('Invalid M365 tenant id');
  const cached = cache.get(tenantId);
  if (cached && cached.expiresAt - Date.now() > FRESH_BUFFER_MS) return cached.token;

  const cfg = getMailboxPlatformConfig();
  if (!cfg) throw new Error('TICKET_MAILBOX_M365_CLIENT_ID/SECRET not configured');

  const res = await acquireClientCredentialsToken({
    tenantId: tenantId as Parameters<typeof acquireClientCredentialsToken>[0]['tenantId'],
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
  });
  cache.set(tenantId, { token: res.accessToken, expiresAt: Date.now() + res.expiresIn * 1000 });
  return res.accessToken;
}
