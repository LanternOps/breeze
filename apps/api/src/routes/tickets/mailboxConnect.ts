import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { authMiddleware, requireScope, requireMfa, type AuthContext } from '../../middleware/auth';
import { buildAdminConsentUrl, isM365TenantId } from '../../services/c2cM365';
import { getMailboxCallbackUri, getMailboxPlatformConfig } from '../../services/ticketMailbox/mailboxToken';
import {
  createPendingConnection, getMailboxConnection, setConnectionTenant,
  setConnectionStatus, probeMailbox, listMailboxConnections, disableConnection,
} from '../../services/ticketMailbox/connectionService';
import { withSystemDbAccessContext, runOutsideDbContext } from '../../db';
import { captureException } from '../../services/sentry';

// requireScope('partner','system') is the partner-scope gate (mirrors
// routes/accounting/index.ts, which aliases the same factory call).
const partnerScopes = requireScope('partner', 'system');

// Ticket mailbox connections are partner-owned. The scope gate also admits
// 'system', but a system token carries no partnerId to operate on, so narrow
// to a concrete partner here (mirrors accounting's resolvePartnerId).
function resolvePartnerId(auth: Pick<AuthContext, 'scope' | 'partnerId'>): { partnerId: string } | { error: string; status: 403 } {
  if (auth.scope === 'partner' && auth.partnerId) return { partnerId: auth.partnerId };
  return { error: 'Partner context required to manage ticket mailbox connections', status: 403 };
}

const STATE_COOKIE = 'ticket_mailbox_oauth_state';
const STATE_TTL_MS = 10 * 60 * 1000;
const LABEL = 'ticket-mailbox-oauth';

interface StatePayload { partnerId: string; userId: string | null; connectionId: string; nonce: string; exp: number; }

function signingSecret(): string | null {
  return process.env.APP_ENCRYPTION_KEY?.trim() || process.env.SECRET_ENCRYPTION_KEY?.trim()
    || process.env.SESSION_SECRET?.trim() || process.env.JWT_SECRET?.trim()
    || (process.env.NODE_ENV === 'production' ? null : 'test-only-ticket-mailbox-oauth-state-secret');
}
function hmac(label: string, value: string): string | null {
  const secret = signingSecret();
  return secret ? createHmac('sha256', secret).update(`${label}:${value}`).digest('base64url') : null;
}
function constantTimeEqual(a: string, b: string): boolean {
  const l = Buffer.from(a, 'utf8'); const r = Buffer.from(b, 'utf8');
  return l.length === r.length && timingSafeEqual(l, r);
}
function createState(p: Omit<StatePayload, 'nonce' | 'exp'>): string | null {
  const payload: StatePayload = { ...p, nonce: randomBytes(16).toString('hex'), exp: Date.now() + STATE_TTL_MS };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = hmac(LABEL, encoded);
  return sig ? `${encoded}.${sig}` : null;
}
function verifyState(state: string): StatePayload | null {
  const [encoded, sig] = state.split('.');
  if (!encoded || !sig) return null;
  const expected = hmac(LABEL, encoded);
  if (!expected || !constantTimeEqual(sig, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as StatePayload;
    if (!parsed.partnerId || !parsed.connectionId || !parsed.nonce || !parsed.exp || parsed.exp < Date.now()) return null;
    return parsed;
  } catch { return null; }
}
function stateCookieValue(state: string): string | null { return hmac(`${LABEL}-cookie`, state); }

const connectBody = z.object({ mailboxAddress: z.string().email(), displayName: z.string().max(120).optional() });
const callbackQuery = z.object({ state: z.string(), tenant: z.string().optional(), admin_consent: z.string().optional(), error: z.string().optional(), error_description: z.string().optional() });
const idParam = z.object({ id: z.string().uuid() });

export const mailboxRoutes = new Hono();

// List
mailboxRoutes.get('/connections', authMiddleware, partnerScopes, async (c) => {
  const resolved = resolvePartnerId(c.get('auth'));
  if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status);
  const list = await listMailboxConnections(resolved.partnerId);
  return c.json({ connections: list });
});

// Initiate consent (creates the pending row, returns admin-consent URL)
mailboxRoutes.post('/connect', authMiddleware, partnerScopes, requireMfa(), zValidator('json', connectBody), async (c) => {
  if (!getMailboxPlatformConfig()) return c.json({ error: 'M365 ticket mailbox app is not configured' }, 400);
  const auth = c.get('auth');
  const resolved = resolvePartnerId(auth);
  if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status);
  const { mailboxAddress, displayName } = c.req.valid('json');
  const conn = await createPendingConnection({
    partnerId: resolved.partnerId, mailboxAddress, displayName: displayName ?? null, createdBy: auth.user?.id ?? null,
  });
  const state = createState({ partnerId: resolved.partnerId, userId: auth.user?.id ?? null, connectionId: conn.id });
  const cookie = state ? stateCookieValue(state) : null;
  if (!state || !cookie) return c.json({ error: 'OAuth state signing secret is not configured' }, 500);
  setCookie(c, STATE_COOKIE, cookie, {
    httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'Lax', path: '/', maxAge: STATE_TTL_MS / 1000,
  });
  const cfg = getMailboxPlatformConfig()!;
  const authUrl = buildAdminConsentUrl({ clientId: cfg.clientId, state, redirectUri: getMailboxCallbackUri() });
  return c.json({ authUrl, connectionId: conn.id });
});

// OAuth redirect target — NO authMiddleware. Authenticated by signed state + cookie.
mailboxRoutes.get('/callback', zValidator('query', callbackQuery), async (c) => {
  const q = c.req.valid('query');
  const state = verifyState(q.state);
  if (!state) return c.json({ error: 'Invalid or expired OAuth state' }, 400);

  const expectedCookie = stateCookieValue(q.state);
  const presented = getCookie(c, STATE_COOKIE);
  if (!expectedCookie || !presented || !constantTimeEqual(presented, expectedCookie)) {
    return c.json({ error: 'OAuth state binding mismatch' }, 400);
  }
  deleteCookie(c, STATE_COOKIE, { path: '/' });

  if (q.error || !q.tenant || !isM365TenantId(q.tenant)) {
    await runOutsideDbContext(() => withSystemDbAccessContext(() =>
      setConnectionStatus(state.connectionId, state.partnerId, 'error', q.error_description ?? q.error ?? 'consent failed')));
    return c.redirect('/integrations?ticketMailbox=error#ticket-mailbox');
  }

  try {
    await runOutsideDbContext(() => withSystemDbAccessContext(() =>
      setConnectionTenant(state.connectionId, state.partnerId, q.tenant!)));
    const probe = await probeMailbox(q.tenant, (await getConnAddress(state)) ?? '');
    await runOutsideDbContext(() => withSystemDbAccessContext(() =>
      setConnectionStatus(state.connectionId, state.partnerId, probe.ok ? 'connected' : 'error', probe.ok ? null : (probe.error ?? 'probe failed'))));
    return c.redirect(probe.ok ? '/integrations?ticketMailbox=connected#ticket-mailbox' : '/integrations?ticketMailbox=needs_policy#ticket-mailbox');
  } catch (err) {
    captureException(err instanceof Error ? err : new Error(String(err)), c);
    return c.redirect('/integrations?ticketMailbox=error#ticket-mailbox');
  }
});

async function getConnAddress(state: StatePayload): Promise<string | null> {
  const conn = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
    getMailboxConnection(state.connectionId, state.partnerId)));
  return conn?.mailboxAddress ?? null;
}

// Re-run the probe (after the admin scopes the Application Access Policy)
mailboxRoutes.post('/connections/:id/retest', authMiddleware, partnerScopes, requireMfa(), zValidator('param', idParam), async (c) => {
  const resolved = resolvePartnerId(c.get('auth'));
  if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status);
  const { id } = c.req.valid('param');
  const conn = await getMailboxConnection(id, resolved.partnerId);
  if (!conn || !conn.tenantId) return c.json({ error: 'Connection not found or not consented' }, 404);
  const probe = await probeMailbox(conn.tenantId, conn.mailboxAddress);
  await setConnectionStatus(id, resolved.partnerId, probe.ok ? 'connected' : 'error', probe.ok ? null : (probe.error ?? 'probe failed'));
  return c.json({ ok: probe.ok, error: probe.error });
});

// Disconnect
mailboxRoutes.delete('/connections/:id', authMiddleware, partnerScopes, requireMfa(), zValidator('param', idParam), async (c) => {
  const resolved = resolvePartnerId(c.get('auth'));
  if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status);
  await disableConnection(c.req.valid('param').id, resolved.partnerId);
  return c.json({ ok: true });
});
