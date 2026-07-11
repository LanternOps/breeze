import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createHmac } from 'crypto';

const FIXED_SECRET = 'test-jwt-secret-must-be-at-least-32-characters-long';
const LABEL = 'ticket-mailbox-oauth';
const PARTNER_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_PARTNER_ID = '99999999-9999-4999-8999-999999999999';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const CONNECTION_ID = '44444444-4444-4444-8444-444444444444';
const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const ATTACKER_TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MICROSOFT_OID = '55555555-5555-4555-8555-555555555555';

type PermissionName = 'ticket_mailbox:read' | 'ticket_mailbox:admin';
type AuthState = {
  scope: 'partner' | 'system' | 'organization';
  partnerId: string | null;
  partnerOrgAccess: 'all' | 'selected' | 'none' | null;
  mfa: boolean;
  permissions: Set<PermissionName>;
};

const { authRef, mocks } = vi.hoisted(() => ({
  authRef: { current: null as AuthState | null },
  mocks: {
    createPendingConnection: vi.fn(),
    getMailboxConnection: vi.fn(),
    setConnectionStatus: vi.fn(async () => {}),
    probeMailbox: vi.fn(),
    bindVerifiedTenant: vi.fn(async () => {}),
    listMailboxConnections: vi.fn(async (): Promise<unknown[]> => []),
    disableConnection: vi.fn(async () => {}),
    createAdminConsentSession: vi.fn(),
    createIdentityVerificationSession: vi.fn(),
    consumeConsentSession: vi.fn(),
    exchangeMicrosoftAuthorizationCode: vi.fn(),
    verifyMicrosoftAdminIdToken: vi.fn(),
    hasMailboxConsentAdminRole: vi.fn(() => true),
    writeRouteAudit: vi.fn(),
    writeAuditEvent: vi.fn(),
    platformConfig: vi.fn((): { clientId: string; clientSecret: string } | null => ({
      clientId: 'platform-client-id', clientSecret: 'platform-client-secret',
    })),
  },
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    if (!authRef.current) return c.json({ error: 'Not authenticated' }, 401);
    c.set('auth', {
      ...authRef.current,
      orgId: null,
      accessibleOrgIds: [],
      user: { id: USER_ID, email: 'admin@example.com', name: 'Admin' },
      token: { mfa: authRef.current.mfa },
    });
    return next();
  }),
  requireScope: vi.fn((...scopes: string[]) => async (c: any, next: any) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Not authenticated' }, 401);
    if (!scopes.includes(auth.scope)) return c.json({ error: 'Insufficient permissions' }, 403);
    return next();
  }),
  requirePermission: vi.fn((resource: string, action: string) => async (c: any, next: any) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Not authenticated' }, 401);
    if (!auth.permissions.has(`${resource}:${action}`)) return c.json({ error: 'Permission denied' }, 403);
    return next();
  }),
  requireMfa: vi.fn(() => async (c: any, next: any) => {
    if (!c.get('auth')?.mfa) return c.json({ error: 'MFA required' }, 403);
    return next();
  }),
}));

vi.mock('../../db', () => ({
  runOutsideDbContext: <T>(fn: () => T) => fn(),
  withSystemDbAccessContext: <T>(fn: () => T) => fn(),
}));

vi.mock('../../services/ticketMailbox/mailboxToken', () => ({
  getMailboxPlatformConfig: () => mocks.platformConfig(),
  getMailboxCallbackUri: () => 'https://app.example.com/api/v1/tickets/mailbox/callback',
}));
vi.mock('../../services/ticketMailbox/connectionService', () => ({
  createPendingConnection: mocks.createPendingConnection,
  getMailboxConnection: mocks.getMailboxConnection,
  setConnectionStatus: mocks.setConnectionStatus,
  probeMailbox: mocks.probeMailbox,
  bindVerifiedTenant: mocks.bindVerifiedTenant,
  listMailboxConnections: mocks.listMailboxConnections,
  disableConnection: mocks.disableConnection,
}));
vi.mock('../../services/ticketMailbox/consentSessionService', () => ({
  createAdminConsentSession: mocks.createAdminConsentSession,
  createIdentityVerificationSession: mocks.createIdentityVerificationSession,
  consumeConsentSession: mocks.consumeConsentSession,
}));
vi.mock('../../services/ticketMailbox/microsoftIdentity', () => ({
  buildMicrosoftAuthorizationUrl: vi.fn((input: Record<string, string>) => {
    const url = new URL(`https://login.microsoftonline.com/${input.tenantHint}/oauth2/v2.0/authorize`);
    Object.entries(input).forEach(([key, value]) => url.searchParams.set(key, value));
    return url.toString();
  }),
  exchangeMicrosoftAuthorizationCode: mocks.exchangeMicrosoftAuthorizationCode,
  verifyMicrosoftAdminIdToken: mocks.verifyMicrosoftAdminIdToken,
  hasMailboxConsentAdminRole: mocks.hasMailboxConsentAdminRole,
}));
vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: mocks.writeRouteAudit,
  writeAuditEvent: mocks.writeAuditEvent,
}));
vi.mock('../../services/sentry', () => ({ captureException: vi.fn() }));

import { PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../../services/partnerWideAccess';
import { mailboxRoutes } from './mailboxConnect';

function cookieFor(phase: 'admin_consent' | 'identity_verification', state: string): string {
  const mac = createHmac('sha256', FIXED_SECRET)
    .update(`${LABEL}-cookie:${phase}:${state}`)
    .digest('base64url');
  return `${phase}.${mac}`;
}

function session(phase: 'admin_consent' | 'identity_verification', overrides: Record<string, unknown> = {}) {
  return {
    state: phase === 'admin_consent' ? 'admin-state' : 'identity-state',
    phase,
    partnerId: PARTNER_ID,
    connectionId: CONNECTION_ID,
    userId: USER_ID,
    tenantHint: phase === 'identity_verification' ? TENANT_ID : null,
    nonce: phase === 'identity_verification' ? 'stored-nonce' : null,
    codeVerifier: phase === 'identity_verification' ? 'stored-code-verifier' : null,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  };
}

function connection(overrides: Record<string, unknown> = {}) {
  return {
    id: CONNECTION_ID,
    partnerId: PARTNER_ID,
    tenantId: TENANT_ID,
    mailboxAddress: 'support@example.com',
    displayName: 'Support',
    status: 'connected',
    deltaLink: null,
    strictSenderAuth: true,
    lastPolledAt: null,
    lastMessageAt: null,
    lastError: null,
    createdBy: USER_ID,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function adminAuth(overrides: Partial<AuthState> = {}): AuthState {
  return {
    scope: 'partner', partnerId: PARTNER_ID, partnerOrgAccess: 'all', mfa: true,
    permissions: new Set<PermissionName>(['ticket_mailbox:read', 'ticket_mailbox:admin']),
    ...overrides,
  };
}

function expectNoLifecycleEffects() {
  expect(mocks.createPendingConnection).not.toHaveBeenCalled();
  expect(mocks.probeMailbox).not.toHaveBeenCalled();
  expect(mocks.bindVerifiedTenant).not.toHaveBeenCalled();
  expect(mocks.disableConnection).not.toHaveBeenCalled();
  expect(mocks.writeRouteAudit).not.toHaveBeenCalled();
  expect(mocks.writeAuditEvent).not.toHaveBeenCalled();
}

describe('M365 mailbox lifecycle routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    authRef.current = adminAuth();
    mocks.platformConfig.mockReturnValue({ clientId: 'platform-client-id', clientSecret: 'platform-client-secret' });
    mocks.createPendingConnection.mockResolvedValue(connection({ status: 'pending_consent', tenantId: null }));
    mocks.createAdminConsentSession.mockResolvedValue(session('admin_consent'));
    mocks.createIdentityVerificationSession.mockResolvedValue({
      session: session('identity_verification'), codeChallenge: 'stored-code-challenge',
    });
    mocks.consumeConsentSession.mockImplementation(async (_state: string, phase: string) => session(phase as never));
    mocks.exchangeMicrosoftAuthorizationCode.mockResolvedValue({ idToken: 'verified-id-token' });
    mocks.verifyMicrosoftAdminIdToken.mockResolvedValue({
      tid: TENANT_ID, oid: MICROSOFT_OID, sub: 'microsoft-sub', wids: ['accepted-role'],
    });
    mocks.hasMailboxConsentAdminRole.mockReturnValue(true);
    mocks.getMailboxConnection.mockResolvedValue(connection());
    mocks.probeMailbox.mockResolvedValue({ ok: true });
    app = new Hono();
    app.route('/', mailboxRoutes);
  });

  describe('GET /connections authorization', () => {
    it('denies unauthenticated callers', async () => {
      authRef.current = null;
      expect((await app.request('/connections')).status).toBe(401);
      expect(mocks.listMailboxConnections).not.toHaveBeenCalled();
    });

    it('denies organization scope', async () => {
      authRef.current = adminAuth({ scope: 'organization', partnerId: null, partnerOrgAccess: null });
      expect((await app.request('/connections')).status).toBe(403);
      expect(mocks.listMailboxConnections).not.toHaveBeenCalled();
    });

    it('denies callers missing mailbox read', async () => {
      authRef.current = adminAuth({ permissions: new Set(['ticket_mailbox:admin']) });
      expect((await app.request('/connections')).status).toBe(403);
      expect(mocks.listMailboxConnections).not.toHaveBeenCalled();
    });

    it('allows a read-only full-partner caller and returns the reduced service DTO', async () => {
      authRef.current = adminAuth({ permissions: new Set(['ticket_mailbox:read']) });
      mocks.listMailboxConnections.mockResolvedValue([{ id: CONNECTION_ID, mailboxAddress: 'support@example.com' }]);
      const response = await app.request('/connections');
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        connections: [{ id: CONNECTION_ID, mailboxAddress: 'support@example.com' }],
      });
      expect(mocks.listMailboxConnections).toHaveBeenCalledWith(PARTNER_ID);
    });
  });

  const mutations = [
    {
      name: 'connect',
      request: (target: Hono) => target.request('/connect', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mailboxAddress: 'support@example.com' }),
      }),
    },
    {
      name: 'retest',
      request: (target: Hono) => target.request(`/connections/${CONNECTION_ID}/retest`, { method: 'POST' }),
    },
    {
      name: 'disable',
      request: (target: Hono) => target.request(`/connections/${CONNECTION_ID}`, { method: 'DELETE' }),
    },
  ];

  describe.each(mutations)('$name lifecycle authorization', ({ request }) => {
    it('denies callers missing mailbox admin', async () => {
      authRef.current = adminAuth({ permissions: new Set(['ticket_mailbox:read']) });
      expect((await request(app)).status).toBe(403);
      expectNoLifecycleEffects();
    });

    it('denies callers missing MFA', async () => {
      authRef.current = adminAuth({ mfa: false });
      expect((await request(app)).status).toBe(403);
      expectNoLifecycleEffects();
    });

    it.each(['selected', 'none'] as const)('denies partner orgAccess=%s before service or audit calls', async (orgAccess) => {
      authRef.current = adminAuth({ partnerOrgAccess: orgAccess });
      const response = await request(app);
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE });
      expectNoLifecycleEffects();
    });
  });

  it('POST /connect creates a single-use admin session, binds its cookie, and audits once', async () => {
    const response = await app.request('/connect', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mailboxAddress: 'support@example.com', displayName: 'Support' }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('ticket_mailbox_oauth_state=admin_consent.');
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(response.headers.get('set-cookie')).toContain('SameSite=Lax');
    expect(mocks.createAdminConsentSession).toHaveBeenCalledWith({
      partnerId: PARTNER_ID, connectionId: CONNECTION_ID, userId: USER_ID,
    });
    expect(mocks.writeRouteAudit).toHaveBeenCalledTimes(1);
    expect(mocks.writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'ticket_mailbox.consent_initiated', resourceId: CONNECTION_ID,
      details: { partnerId: PARTNER_ID, connectionId: CONNECTION_ID, mailboxAddress: 'support@example.com', outcome: 'initiated' },
    }));
  });

  it('admin consent treats tenant as an endpoint hint only and rotates into identity verification', async () => {
    const adminState = 'admin-state';
    const response = await app.request(
      `/callback?state=${adminState}&tenant=${ATTACKER_TENANT}&admin_consent=True`,
      { headers: { cookie: `ticket_mailbox_oauth_state=${cookieFor('admin_consent', adminState)}` } },
    );
    expect(response.status).toBe(302);
    expect(mocks.consumeConsentSession).toHaveBeenCalledWith(adminState, 'admin_consent');
    expect(mocks.createIdentityVerificationSession).toHaveBeenCalledWith({
      partnerId: PARTNER_ID, connectionId: CONNECTION_ID, userId: USER_ID, tenantHint: ATTACKER_TENANT,
    });
    expect(response.headers.get('set-cookie')).toContain('ticket_mailbox_oauth_state=identity_verification.');
    expect(response.headers.get('location')).toContain(`/${ATTACKER_TENANT}/oauth2/v2.0/authorize`);
    expect(mocks.probeMailbox).not.toHaveBeenCalled();
    expect(mocks.bindVerifiedTenant).not.toHaveBeenCalled();
    expect(mocks.setConnectionStatus).not.toHaveBeenCalled();
  });

  it.each(['admin_consent', 'identity_verification'] as const)(
    'consumes a %s provider error once and writes one sanitized failure audit',
    async (phase) => {
      const state = phase === 'admin_consent' ? 'admin-state' : 'identity-state';
      const response = await app.request(`/callback?state=${state}&error=access_denied&error_description=raw-provider-detail`, {
        headers: { cookie: `ticket_mailbox_oauth_state=${cookieFor(phase, state)}` },
      });
      expect(response.status).toBe(302);
      expect(mocks.consumeConsentSession).toHaveBeenCalledWith(state, phase);
      expect(mocks.writeAuditEvent).toHaveBeenCalledTimes(1);
      expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        action: 'ticket_mailbox.verification_failed', actorId: USER_ID,
        details: expect.objectContaining({ outcome: 'invalid_identity' }),
      }));
      expect(JSON.stringify(mocks.writeAuditEvent.mock.calls)).not.toContain('raw-provider-detail');
      expect(mocks.probeMailbox).not.toHaveBeenCalled();
      expect(mocks.bindVerifiedTenant).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['missing', undefined],
    ['mismatched', 'identity_verification.invalid-cookie-mac'],
  ])('rejects a %s browser-binding cookie before consuming state', async (_label, cookie) => {
    const response = await app.request('/callback?state=admin-state&tenant=11111111-1111-4111-8111-111111111111&admin_consent=True', {
      headers: cookie ? { cookie: `ticket_mailbox_oauth_state=${cookie}` } : undefined,
    });
    expect(response.status).toBe(400);
    expect(mocks.consumeConsentSession).not.toHaveBeenCalled();
    expect(mocks.writeAuditEvent).not.toHaveBeenCalled();
  });

  it('identity callback uses stored PKCE/nonce/platform credentials and binds only verified tid', async () => {
    const identityState = 'identity-state';
    const response = await app.request(`/callback?state=${identityState}&code=authorization-code`, {
      headers: { cookie: `ticket_mailbox_oauth_state=${cookieFor('identity_verification', identityState)}` },
    });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('ticketMailbox=connected');
    expect(mocks.consumeConsentSession).toHaveBeenCalledWith(identityState, 'identity_verification');
    expect(mocks.exchangeMicrosoftAuthorizationCode).toHaveBeenCalledWith({
      tenantHint: TENANT_ID,
      clientId: 'platform-client-id',
      clientSecret: 'platform-client-secret',
      redirectUri: 'https://app.example.com/api/v1/tickets/mailbox/callback',
      code: 'authorization-code',
      codeVerifier: 'stored-code-verifier',
    });
    expect(mocks.verifyMicrosoftAdminIdToken).toHaveBeenCalledWith('verified-id-token', {
      tenantHint: TENANT_ID, clientId: 'platform-client-id', nonce: 'stored-nonce',
    });
    expect(mocks.getMailboxConnection).toHaveBeenCalledWith(CONNECTION_ID, PARTNER_ID);
    expect(mocks.probeMailbox).toHaveBeenCalledWith(TENANT_ID, 'support@example.com');
    expect(mocks.bindVerifiedTenant).toHaveBeenCalledWith(CONNECTION_ID, PARTNER_ID, TENANT_ID, {
      microsoftOid: MICROSOFT_OID, breezeUserId: USER_ID,
    });
    expect(mocks.writeAuditEvent).toHaveBeenCalledTimes(1);
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'ticket_mailbox.tenant_binding_verified', actorId: USER_ID,
      details: {
        partnerId: PARTNER_ID, connectionId: CONNECTION_ID, mailboxAddress: 'support@example.com',
        verifiedTenantId: TENANT_ID, outcome: 'verified',
      },
    }));
    expect(JSON.stringify(mocks.writeAuditEvent.mock.calls)).not.toContain('authorization-code');
    expect(JSON.stringify(mocks.writeAuditEvent.mock.calls)).not.toContain('verified-id-token');
    expect(JSON.stringify(mocks.writeAuditEvent.mock.calls)).not.toContain('platform-client-secret');
  });

  it('rejects callback query injection that mixes identity code with a tenant hint', async () => {
    const identityState = 'identity-state';
    const response = await app.request(
      `/callback?state=${identityState}&code=authorization-code&tenant=${ATTACKER_TENANT}`,
      { headers: { cookie: `ticket_mailbox_oauth_state=${cookieFor('identity_verification', identityState)}` } },
    );
    expect(response.status).toBe(400);
    expect(mocks.consumeConsentSession).not.toHaveBeenCalled();
    expect(mocks.probeMailbox).not.toHaveBeenCalled();
    expect(mocks.bindVerifiedTenant).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid code', 'exchange'],
    ['invalid issuer', 'verify'],
    ['invalid audience', 'verify'],
    ['invalid nonce', 'verify'],
    ['invalid tenant', 'verify'],
  ])('%s fails closed without probing or binding', async (_label, failureAt) => {
    if (failureAt === 'exchange') mocks.exchangeMicrosoftAuthorizationCode.mockRejectedValue(new Error('raw token body'));
    else mocks.verifyMicrosoftAdminIdToken.mockRejectedValue(new Error('raw identity detail'));
    const response = await app.request('/callback?state=identity-state&code=bad-code', {
      headers: { cookie: `ticket_mailbox_oauth_state=${cookieFor('identity_verification', 'identity-state')}` },
    });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('ticketMailbox=error');
    expect(mocks.probeMailbox).not.toHaveBeenCalled();
    expect(mocks.bindVerifiedTenant).not.toHaveBeenCalled();
    expect(mocks.writeAuditEvent).toHaveBeenCalledTimes(1);
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'ticket_mailbox.verification_failed', actorId: USER_ID,
      details: expect.objectContaining({ outcome: 'invalid_identity' }),
    }));
    const serialized = JSON.stringify(mocks.writeAuditEvent.mock.calls);
    expect(serialized).not.toContain('raw token body');
    expect(serialized).not.toContain('raw identity detail');
    expect(serialized).not.toContain('bad-code');
  });

  it('rejects an identity without an accepted administrator role', async () => {
    mocks.hasMailboxConsentAdminRole.mockReturnValue(false);
    const response = await app.request('/callback?state=identity-state&code=authorization-code', {
      headers: { cookie: `ticket_mailbox_oauth_state=${cookieFor('identity_verification', 'identity-state')}` },
    });
    expect(response.status).toBe(302);
    expect(mocks.probeMailbox).not.toHaveBeenCalled();
    expect(mocks.bindVerifiedTenant).not.toHaveBeenCalled();
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      details: expect.objectContaining({ outcome: 'insufficient_role' }),
    }));
  });

  it('rejects replayed state before any identity or audit work', async () => {
    mocks.consumeConsentSession.mockResolvedValue(null);
    const response = await app.request('/callback?state=identity-state&code=authorization-code', {
      headers: { cookie: `ticket_mailbox_oauth_state=${cookieFor('identity_verification', 'identity-state')}` },
    });
    expect(response.status).toBe(400);
    expect(mocks.exchangeMicrosoftAuthorizationCode).not.toHaveBeenCalled();
    expect(mocks.probeMailbox).not.toHaveBeenCalled();
    expect(mocks.bindVerifiedTenant).not.toHaveBeenCalled();
    expect(mocks.writeAuditEvent).not.toHaveBeenCalled();
  });

  it('never binds tenant ownership when the stored mailbox probe fails', async () => {
    mocks.probeMailbox.mockResolvedValue({ ok: false, error: 'Graph leaked body' });
    const response = await app.request('/callback?state=identity-state&code=authorization-code', {
      headers: { cookie: `ticket_mailbox_oauth_state=${cookieFor('identity_verification', 'identity-state')}` },
    });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('ticketMailbox=needs_policy');
    expect(mocks.probeMailbox).toHaveBeenCalledWith(TENANT_ID, 'support@example.com');
    expect(mocks.bindVerifiedTenant).not.toHaveBeenCalled();
    expect(mocks.setConnectionStatus).toHaveBeenCalledWith(CONNECTION_ID, PARTNER_ID, 'error', 'Mailbox verification failed');
    expect(mocks.writeAuditEvent).toHaveBeenCalledTimes(1);
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      details: expect.objectContaining({ verifiedTenantId: TENANT_ID, outcome: 'probe_failed' }),
    }));
    expect(JSON.stringify(mocks.writeAuditEvent.mock.calls)).not.toContain('Graph leaked body');
  });

  it('audits a cross-partner ownership conflict without exposing the service error', async () => {
    mocks.bindVerifiedTenant.mockRejectedValue(new Error(`Mailbox tenant is already owned by another partner: ${OTHER_PARTNER_ID}`));
    const response = await app.request('/callback?state=identity-state&code=authorization-code', {
      headers: { cookie: `ticket_mailbox_oauth_state=${cookieFor('identity_verification', 'identity-state')}` },
    });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('ticketMailbox=error');
    expect(mocks.writeAuditEvent).toHaveBeenCalledTimes(1);
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      details: expect.objectContaining({ outcome: 'ownership_conflict' }),
    }));
    expect(JSON.stringify(mocks.writeAuditEvent.mock.calls)).not.toContain(OTHER_PARTNER_ID);
  });

  it('does not misclassify a non-ownership bind failure as a cross-partner conflict', async () => {
    mocks.bindVerifiedTenant.mockRejectedValue(new Error('Pending mailbox connection not found'));
    await app.request('/callback?state=identity-state&code=authorization-code', {
      headers: { cookie: `ticket_mailbox_oauth_state=${cookieFor('identity_verification', 'identity-state')}` },
    });
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      details: expect.objectContaining({ outcome: 'invalid_identity' }),
    }));
  });

  it('writes one sanitized failure audit even when callback cleanup reads and writes fail', async () => {
    mocks.exchangeMicrosoftAuthorizationCode.mockRejectedValue(new Error('sanitized upstream failure'));
    mocks.getMailboxConnection.mockRejectedValue(new Error('database read detail'));
    mocks.setConnectionStatus.mockRejectedValue(new Error('database write detail'));
    const response = await app.request('/callback?state=identity-state&code=authorization-code', {
      headers: { cookie: `ticket_mailbox_oauth_state=${cookieFor('identity_verification', 'identity-state')}` },
    });
    expect(response.status).toBe(302);
    expect(mocks.writeAuditEvent).toHaveBeenCalledTimes(1);
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'ticket_mailbox.verification_failed', actorId: USER_ID,
      details: { partnerId: PARTNER_ID, connectionId: CONNECTION_ID, outcome: 'invalid_identity' },
    }));
    const serialized = JSON.stringify(mocks.writeAuditEvent.mock.calls);
    expect(serialized).not.toContain('database read detail');
    expect(serialized).not.toContain('database write detail');
  });

  it.each([
    ['reauth_required', TENANT_ID],
    ['pending_consent', null],
    ['error', null],
    ['connected', null],
  ])('retest rejects %s/tenant=%s with re-consent required', async (status, tenantId) => {
    mocks.getMailboxConnection.mockResolvedValue(connection({ status, tenantId }));
    const response = await app.request(`/connections/${CONNECTION_ID}/retest`, { method: 'POST' });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: 'Mailbox re-consent required' });
    expect(mocks.probeMailbox).not.toHaveBeenCalled();
    expect(mocks.writeRouteAudit).not.toHaveBeenCalled();
  });

  it('retests only a connected verified tenant and audits exactly once', async () => {
    const response = await app.request(`/connections/${CONNECTION_ID}/retest`, { method: 'POST' });
    expect(response.status).toBe(200);
    expect(mocks.probeMailbox).toHaveBeenCalledWith(TENANT_ID, 'support@example.com');
    expect(mocks.bindVerifiedTenant).not.toHaveBeenCalled();
    expect(mocks.setConnectionStatus).not.toHaveBeenCalled();
    expect(mocks.writeRouteAudit).toHaveBeenCalledTimes(1);
    expect(mocks.writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'ticket_mailbox.retested',
      details: expect.objectContaining({ verifiedTenantId: TENANT_ID, outcome: 'verified' }),
    }));
  });

  it('disables and audits exactly once after the service succeeds', async () => {
    const response = await app.request(`/connections/${CONNECTION_ID}`, { method: 'DELETE' });
    expect(response.status).toBe(200);
    expect(mocks.disableConnection).toHaveBeenCalledWith(CONNECTION_ID, PARTNER_ID);
    expect(mocks.writeRouteAudit).toHaveBeenCalledTimes(1);
    expect(mocks.writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'ticket_mailbox.disabled',
      details: {
        partnerId: PARTNER_ID, connectionId: CONNECTION_ID,
        mailboxAddress: 'support@example.com', verifiedTenantId: TENANT_ID, outcome: 'disabled',
      },
    }));
  });

  it.each([
    ['/callback?state=admin-state', 'admin_consent'],
    ['/callback?state=admin-state&tenant=not-a-guid&admin_consent=True', 'admin_consent'],
    ['/callback?state=identity-state', 'identity_verification'],
    ['/callback?state=identity-state&code=x&error=access_denied', 'identity_verification'],
  ])('rejects missing or ambiguous callback input: %s', async (path, phase) => {
    const state = phase === 'admin_consent' ? 'admin-state' : 'identity-state';
    const response = await app.request(path, {
      headers: { cookie: `ticket_mailbox_oauth_state=${cookieFor(phase as never, state)}` },
    });
    expect(response.status).toBe(400);
    expect(mocks.consumeConsentSession).not.toHaveBeenCalled();
    expect(mocks.probeMailbox).not.toHaveBeenCalled();
    expect(mocks.bindVerifiedTenant).not.toHaveBeenCalled();
  });

  it.each(['state', 'code', 'tenant', 'admin_consent', 'error'])(
    'rejects duplicate %s callback parameters without consuming state',
    async (field) => {
      const base = new URL('https://example.test/callback');
      base.searchParams.set('state', 'identity-state');
      base.searchParams.set('code', 'authorization-code');
      base.searchParams.append(field, field === 'state' ? 'other-state' : 'duplicate');
      const response = await app.request(`${base.pathname}${base.search}`, {
        headers: { cookie: `ticket_mailbox_oauth_state=${cookieFor('identity_verification', 'identity-state')}` },
      });
      expect(response.status).toBe(400);
      expect(mocks.consumeConsentSession).not.toHaveBeenCalled();
      expect(mocks.probeMailbox).not.toHaveBeenCalled();
      expect(mocks.bindVerifiedTenant).not.toHaveBeenCalled();
    },
  );
});
