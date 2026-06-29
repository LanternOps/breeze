import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createHmac } from 'crypto';

// signingSecret() falls through APP_ENCRYPTION_KEY/SECRET_ENCRYPTION_KEY/
// SESSION_SECRET to JWT_SECRET, which the api test setup (src/__tests__/setup.ts)
// sets. Mint state with that same ambient secret — do NOT stub env here (it would
// perturb the shared-worker process.env that sibling tests read).
const FIXED_SECRET = 'test-jwt-secret-must-be-at-least-32-characters-long';
const LABEL = 'ticket-mailbox-oauth';
const TENANT = '11111111-1111-1111-1111-111111111111';

function mintState(
  partnerId: string, connectionId: string, userId: string | null, exp = Date.now() + 60_000,
): { state: string; cookie: string } {
  const payload = { partnerId, userId, connectionId, nonce: 'test-nonce', exp };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = createHmac('sha256', FIXED_SECRET).update(`${LABEL}:${encoded}`).digest('base64url');
  const state = `${encoded}.${sig}`;
  const cookie = createHmac('sha256', FIXED_SECRET).update(`${LABEL}-cookie:${state}`).digest('base64url');
  return { state, cookie };
}

const { authState, mocks } = vi.hoisted(() => ({
  authState: {
    scope: 'partner' as 'partner' | 'system' | 'organization',
    partnerId: '22222222-2222-2222-2222-222222222222' as string | null,
    mfa: true,
  },
  mocks: {
    createPendingConnection: vi.fn(),
    getMailboxConnection: vi.fn(),
    setConnectionTenant: vi.fn(async () => {}),
    setConnectionStatus: vi.fn(async () => {}),
    probeMailbox: vi.fn(),
    listMailboxConnections: vi.fn(async (): Promise<any[]> => []),
    disableConnection: vi.fn(async () => {}),
    platformConfig: vi.fn((): { clientId: string; clientSecret: string } | null => ({ clientId: 'cid', clientSecret: 'csecret' })),
  },
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    c.set('auth', {
      scope: authState.scope,
      partnerId: authState.partnerId,
      orgId: null,
      accessibleOrgIds: [],
      user: { id: '33333333-3333-3333-3333-333333333333', email: 'admin@example.com', name: 'Admin' },
      token: { mfa: authState.mfa },
    });
    return next();
  }),
  requireScope: vi.fn((...scopes: string[]) => async (c: any, next: any) => {
    if (!scopes.includes(authState.scope)) return c.json({ error: 'Insufficient permissions' }, 403);
    return next();
  }),
  requireMfa: vi.fn(() => async (c: any, next: any) => {
    if (!authState.mfa) return c.json({ error: 'MFA required' }, 403);
    return next();
  }),
}));

vi.mock('../../db', () => ({
  runOutsideDbContext: <T>(fn: () => T) => fn(),
  withSystemDbAccessContext: <T>(fn: () => T) => fn(),
}));

vi.mock('../../services/sentry', () => ({ captureException: vi.fn() }));

vi.mock('../../services/ticketMailbox/mailboxToken', () => ({
  getMailboxPlatformConfig: () => mocks.platformConfig(),
  getMailboxCallbackUri: () => 'https://app.example.com/api/v1/tickets/mailbox/callback',
}));

vi.mock('../../services/ticketMailbox/connectionService', () => ({
  createPendingConnection: mocks.createPendingConnection,
  getMailboxConnection: mocks.getMailboxConnection,
  setConnectionTenant: mocks.setConnectionTenant,
  setConnectionStatus: mocks.setConnectionStatus,
  probeMailbox: mocks.probeMailbox,
  listMailboxConnections: mocks.listMailboxConnections,
  disableConnection: mocks.disableConnection,
}));

import { mailboxRoutes } from './mailboxConnect';

describe('M365 mailbox connect/callback routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    authState.scope = 'partner';
    authState.partnerId = '22222222-2222-2222-2222-222222222222';
    authState.mfa = true;
    mocks.platformConfig.mockReturnValue({ clientId: 'cid', clientSecret: 'csecret' });
    mocks.createPendingConnection.mockResolvedValue({ id: 'conn-1', partnerId: authState.partnerId, mailboxAddress: 'support@a.com' });
    mocks.getMailboxConnection.mockResolvedValue({ id: 'conn-1', partnerId: authState.partnerId, tenantId: TENANT, mailboxAddress: 'support@a.com', status: 'connected' });
    mocks.probeMailbox.mockResolvedValue({ ok: true });
    app = new Hono();
    app.route('/tickets/mailbox', mailboxRoutes);
  });

  it('POST /connect returns an admin-consent authUrl and sets the state cookie', async () => {
    const res = await app.request('/tickets/mailbox/connect', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mailboxAddress: 'support@a.com', displayName: 'Support' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.authUrl).toContain('login.microsoftonline.com');
    expect(body.authUrl).toContain('adminconsent');
    expect(body.connectionId).toBe('conn-1');
    expect(res.headers.get('set-cookie')).toContain('ticket_mailbox_oauth_state');
    expect(mocks.createPendingConnection).toHaveBeenCalledWith(
      expect.objectContaining({ partnerId: authState.partnerId, mailboxAddress: 'support@a.com' }),
    );
  });

  it('POST /connect returns 400 when the M365 app is not configured', async () => {
    mocks.platformConfig.mockReturnValue(null);
    const res = await app.request('/tickets/mailbox/connect', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mailboxAddress: 'support@a.com' }),
    });
    expect(res.status).toBe(400);
    expect(mocks.createPendingConnection).not.toHaveBeenCalled();
  });

  it('POST /connect requires MFA', async () => {
    authState.mfa = false;
    const res = await app.request('/tickets/mailbox/connect', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mailboxAddress: 'support@a.com' }),
    });
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: 'MFA required' });
    expect(mocks.createPendingConnection).not.toHaveBeenCalled();
  });

  it('GET /callback rejects an unsigned/invalid state with 400', async () => {
    const res = await app.request(`/tickets/mailbox/callback?state=bogus&tenant=${TENANT}&admin_consent=True`);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining('OAuth state') });
    expect(mocks.setConnectionTenant).not.toHaveBeenCalled();
  });

  it('GET /callback is NOT behind authMiddleware: valid state+cookie + probe ok → connected redirect', async () => {
    const { state, cookie } = mintState(authState.partnerId!, 'conn-1', '33333333-3333-3333-3333-333333333333');
    const res = await app.request(
      `/tickets/mailbox/callback?state=${encodeURIComponent(state)}&tenant=${TENANT}&admin_consent=True`,
      { headers: { Cookie: `ticket_mailbox_oauth_state=${cookie}` } },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('ticketMailbox=connected');
    expect(mocks.setConnectionTenant).toHaveBeenCalledWith('conn-1', authState.partnerId, TENANT);
    expect(mocks.setConnectionStatus).toHaveBeenCalledWith('conn-1', authState.partnerId, 'connected', null);
  });

  it('GET /callback with probe failure → needs_policy redirect (status=error)', async () => {
    mocks.probeMailbox.mockResolvedValue({ ok: false, error: 'Graph returned 403' });
    const { state, cookie } = mintState(authState.partnerId!, 'conn-1', null);
    const res = await app.request(
      `/tickets/mailbox/callback?state=${encodeURIComponent(state)}&tenant=${TENANT}&admin_consent=True`,
      { headers: { Cookie: `ticket_mailbox_oauth_state=${cookie}` } },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('ticketMailbox=needs_policy');
    expect(mocks.setConnectionStatus).toHaveBeenCalledWith('conn-1', authState.partnerId, 'error', 'Graph returned 403');
  });

  it('GET /callback with a consent error param → error redirect, marks status error', async () => {
    const { state, cookie } = mintState(authState.partnerId!, 'conn-1', null);
    const res = await app.request(
      `/tickets/mailbox/callback?state=${encodeURIComponent(state)}&error=access_denied&error_description=admin%20declined`,
      { headers: { Cookie: `ticket_mailbox_oauth_state=${cookie}` } },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('ticketMailbox=error');
    expect(mocks.setConnectionStatus).toHaveBeenCalledWith('conn-1', authState.partnerId, 'error', 'admin declined');
    expect(mocks.setConnectionTenant).not.toHaveBeenCalled();
  });

  it('GET /callback valid state but MISSING binding cookie is rejected (CSRF)', async () => {
    const { state } = mintState(authState.partnerId!, 'conn-1', null);
    const res = await app.request(
      `/tickets/mailbox/callback?state=${encodeURIComponent(state)}&tenant=${TENANT}&admin_consent=True`,
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining('binding') });
    expect(mocks.setConnectionTenant).not.toHaveBeenCalled();
  });

  it('GET /callback PRESENT but MISMATCHED binding cookie is rejected (CSRF)', async () => {
    const { state } = mintState(authState.partnerId!, 'conn-1', null);
    const other = mintState(authState.partnerId!, 'conn-1', null, Date.now() + 120_000);
    const res = await app.request(
      `/tickets/mailbox/callback?state=${encodeURIComponent(state)}&tenant=${TENANT}&admin_consent=True`,
      { headers: { Cookie: `ticket_mailbox_oauth_state=${other.cookie}` } },
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining('binding') });
    expect(mocks.setConnectionTenant).not.toHaveBeenCalled();
  });

  it('GET /callback with an EXPIRED state is rejected', async () => {
    const { state, cookie } = mintState(authState.partnerId!, 'conn-1', null, Date.now() - 1000);
    const res = await app.request(
      `/tickets/mailbox/callback?state=${encodeURIComponent(state)}&tenant=${TENANT}&admin_consent=True`,
      { headers: { Cookie: `ticket_mailbox_oauth_state=${cookie}` } },
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining('OAuth state') });
    expect(mocks.setConnectionTenant).not.toHaveBeenCalled();
  });

  it('DELETE /connections/:id disconnects (requires MFA)', async () => {
    const id = '44444444-4444-4444-8444-444444444444';
    const res = await app.request(`/tickets/mailbox/connections/${id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true });
    expect(mocks.disableConnection).toHaveBeenCalledWith(id, authState.partnerId);
  });

  it('GET /connections lists connections for the partner', async () => {
    mocks.listMailboxConnections.mockResolvedValue([{ id: 'conn-1', mailboxAddress: 'support@a.com' }]);
    const res = await app.request('/tickets/mailbox/connections');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ connections: [{ id: 'conn-1' }] });
  });
});
