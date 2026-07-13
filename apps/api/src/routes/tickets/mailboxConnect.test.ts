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
const ATTEMPT_ID = '66666666-6666-4666-8666-666666666666';

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
    markPendingConsentFailed: vi.fn(async () => true),
    setConnectedMailboxStatus: vi.fn(async () => true),
    restoreVerifiedConnection: vi.fn(async () => true),
    isMailboxConnectionSnapshotCurrent: vi.fn(async () => true),
    probeMailbox: vi.fn(),
    bindVerifiedTenant: vi.fn(async () => {}),
    listMailboxConnections: vi.fn(async (): Promise<unknown[]> => []),
    disableConnection: vi.fn(async () => true),
    createAdminConsentSession: vi.fn(),
    createIdentityVerificationSession: vi.fn(),
    consumeConsentSession: vi.fn(),
    hashTenantHint: vi.fn((tenant: string) => `tenant-hash:${tenant.toLowerCase()}`),
    exchangeMicrosoftAuthorizationCode: vi.fn(),
    verifyMicrosoftAdminIdToken: vi.fn(),
    hasMailboxConsentAdminRole: vi.fn(() => true),
    writeRouteAudit: vi.fn(),
    writeAuditEvent: vi.fn(),
    captureException: vi.fn(),
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
  markPendingConsentFailed: mocks.markPendingConsentFailed,
  setConnectedMailboxStatus: mocks.setConnectedMailboxStatus,
  restoreVerifiedConnection: mocks.restoreVerifiedConnection,
  isMailboxConnectionSnapshotCurrent: mocks.isMailboxConnectionSnapshotCurrent,
  probeMailbox: mocks.probeMailbox,
  bindVerifiedTenant: mocks.bindVerifiedTenant,
  listMailboxConnections: mocks.listMailboxConnections,
  disableConnection: mocks.disableConnection,
}));
vi.mock('../../services/ticketMailbox/consentSessionService', () => ({
  createAdminConsentSession: mocks.createAdminConsentSession,
  createIdentityVerificationSession: mocks.createIdentityVerificationSession,
  consumeConsentSession: mocks.consumeConsentSession,
  hashTenantHint: mocks.hashTenantHint,
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
vi.mock('../../services/sentry', () => ({ captureException: mocks.captureException }));

import { PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../../services/partnerWideAccess';
import { mailboxRoutes } from './mailboxConnect';

function cookieFor(
  phase: 'admin_consent' | 'identity_verification',
  state: string,
  tenantHint = phase === 'identity_verification' ? TENANT_ID : null,
): string {
  const signedPayload = tenantHint ? `${phase}:${state}:${tenantHint}` : `${phase}:${state}`;
  const mac = createHmac('sha256', FIXED_SECRET)
    .update(`${LABEL}-cookie:${signedPayload}`)
    .digest('base64url');
  return tenantHint ? `${phase}.${tenantHint}.${mac}` : `${phase}.${mac}`;
}

function session(phase: 'admin_consent' | 'identity_verification', overrides: Record<string, unknown> = {}) {
  return {
    state: phase === 'admin_consent' ? 'admin-state' : 'identity-state',
    phase,
    partnerId: PARTNER_ID,
    connectionId: CONNECTION_ID,
    consentAttemptId: ATTEMPT_ID,
    userId: USER_ID,
    tenantHintHash: phase === 'identity_verification' ? `tenant-hash:${TENANT_ID}` : null,
    nonce: phase === 'identity_verification' ? 'stored-nonce' : null,
    codeVerifier: phase === 'identity_verification' ? 'stored-code-verifier' : null,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  };
}

function connection(overrides: Record<string, unknown> = {}) {
  return {
    id: CONNECTION_ID,
    consentAttemptId: ATTEMPT_ID,
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
    mocks.markPendingConsentFailed.mockResolvedValue(true);
    mocks.setConnectedMailboxStatus.mockResolvedValue(true);
    mocks.restoreVerifiedConnection.mockResolvedValue(true);
    mocks.isMailboxConnectionSnapshotCurrent.mockResolvedValue(true);
    mocks.bindVerifiedTenant.mockResolvedValue(undefined);
    mocks.disableConnection.mockResolvedValue(true);
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

    it('allows system scope only when auth supplies a server-derived partner', async () => {
      authRef.current = adminAuth({ scope: 'system', partnerId: PARTNER_ID, partnerOrgAccess: null });
      expect((await app.request('/connections')).status).toBe(200);
      expect(mocks.listMailboxConnections).toHaveBeenCalledWith(PARTNER_ID);
    });

    it('denies system scope without a server-derived partner', async () => {
      authRef.current = adminAuth({ scope: 'system', partnerId: null, partnerOrgAccess: null });
      expect((await app.request('/connections')).status).toBe(403);
      expect(mocks.listMailboxConnections).not.toHaveBeenCalled();
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

    it('allows system scope with a server-derived partner', async () => {
      authRef.current = adminAuth({ scope: 'system', partnerId: PARTNER_ID, partnerOrgAccess: null });
      expect((await request(app)).status).toBe(200);
    });

    it('denies system scope without a server-derived partner before mutation', async () => {
      authRef.current = adminAuth({ scope: 'system', partnerId: null, partnerOrgAccess: null });
      expect((await request(app)).status).toBe(403);
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
      partnerId: PARTNER_ID, connectionId: CONNECTION_ID,
      consentAttemptId: ATTEMPT_ID, userId: USER_ID,
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
      partnerId: PARTNER_ID, connectionId: CONNECTION_ID,
      consentAttemptId: ATTEMPT_ID, userId: USER_ID, tenantHint: ATTACKER_TENANT,
    });
    expect(response.headers.get('set-cookie')).toContain('ticket_mailbox_oauth_state=identity_verification.');
    expect(response.headers.get('location')).toContain(`/${ATTACKER_TENANT}/oauth2/v2.0/authorize`);
    expect(mocks.probeMailbox).not.toHaveBeenCalled();
    expect(mocks.bindVerifiedTenant).not.toHaveBeenCalled();
    expect(mocks.markPendingConsentFailed).not.toHaveBeenCalled();
  });

  it('sanitizes identity-session creation failures before sending them to telemetry', async () => {
    const rawDatabaseMessage = [
      'duplicate key',
      'admin-state',
      'leaked-nonce',
      'leaked-pkce-verifier',
    ].join(':');
    mocks.createIdentityVerificationSession.mockRejectedValue(new Error(rawDatabaseMessage));

    const response = await app.request(
      `/callback?state=admin-state&tenant=${TENANT_ID}&admin_consent=True`,
      { headers: { cookie: `ticket_mailbox_oauth_state=${cookieFor('admin_consent', 'admin-state')}` } },
    );

    expect(response.status).toBe(302);
    expect(mocks.captureException).toHaveBeenCalledTimes(1);
    const telemetryError = mocks.captureException.mock.calls[0]?.[0];
    expect(telemetryError).toBeInstanceOf(Error);
    expect((telemetryError as Error).message).toBe('Mailbox identity setup failed');
    const serializedTelemetry = String((telemetryError as Error).message);
    expect(serializedTelemetry).not.toContain(rawDatabaseMessage);
    expect(serializedTelemetry).not.toContain('admin-state');
    expect(serializedTelemetry).not.toContain('leaked-nonce');
    expect(serializedTelemetry).not.toContain('leaked-pkce-verifier');
  });

  it.each(['admin_consent', 'identity_verification'] as const)(
    'consumes a %s provider error once, requires re-consent, and writes one sanitized failure audit',
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
      expect(mocks.markPendingConsentFailed).toHaveBeenCalledWith(
        CONNECTION_ID, PARTNER_ID, ATTEMPT_ID, 'Mailbox verification failed',
      );
    },
  );

  it('treats a consumed callback from an older consent attempt as one audited stale no-op', async () => {
    mocks.markPendingConsentFailed.mockResolvedValue(false);
    const response = await app.request(
      '/callback?state=identity-state&error=access_denied',
      { headers: { cookie: `ticket_mailbox_oauth_state=${cookieFor('identity_verification', 'identity-state')}` } },
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('ticketMailbox=stale');
    expect(mocks.markPendingConsentFailed).toHaveBeenCalledWith(
      CONNECTION_ID, PARTNER_ID, ATTEMPT_ID, 'Mailbox verification failed',
    );
    expect(mocks.writeAuditEvent).toHaveBeenCalledTimes(1);
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'ticket_mailbox.verification_failed',
      details: expect.objectContaining({ outcome: 'stale_attempt' }),
    }));
  });

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
    expect(mocks.bindVerifiedTenant).toHaveBeenCalledWith(
      CONNECTION_ID, PARTNER_ID, ATTEMPT_ID, TENANT_ID, {
      microsoftOid: MICROSOFT_OID, breezeUserId: USER_ID,
      },
    );
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

  it('cannot bind a completed callback after a newer connect attempt replaced its generation', async () => {
    mocks.bindVerifiedTenant.mockRejectedValue(new Error('Pending mailbox connection attempt is stale'));
    mocks.markPendingConsentFailed.mockResolvedValue(false);

    const response = await app.request('/callback?state=identity-state&code=authorization-code', {
      headers: { cookie: `ticket_mailbox_oauth_state=${cookieFor('identity_verification', 'identity-state')}` },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('ticketMailbox=stale');
    expect(mocks.writeAuditEvent).toHaveBeenCalledTimes(1);
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'ticket_mailbox.verification_failed',
      details: expect.objectContaining({ outcome: 'stale_attempt' }),
    }));
  });

  it('rejects an identity cookie tenant whose hash does not match the consumed session', async () => {
    const response = await app.request('/callback?state=identity-state&code=authorization-code', {
      headers: {
        cookie: `ticket_mailbox_oauth_state=${cookieFor('identity_verification', 'identity-state', ATTACKER_TENANT)}`,
      },
    });

    expect(response.status).toBe(400);
    expect(mocks.consumeConsentSession).toHaveBeenCalledWith('identity-state', 'identity_verification');
    expect(mocks.exchangeMicrosoftAuthorizationCode).not.toHaveBeenCalled();
    expect(mocks.verifyMicrosoftAdminIdToken).not.toHaveBeenCalled();
    expect(mocks.probeMailbox).not.toHaveBeenCalled();
    expect(mocks.bindVerifiedTenant).not.toHaveBeenCalled();
    expect(mocks.writeAuditEvent).not.toHaveBeenCalled();
  });

  it('rejects an identity cookie without its tenant before consuming state', async () => {
    const mac = createHmac('sha256', FIXED_SECRET)
      .update(`${LABEL}-cookie:identity_verification:identity-state`)
      .digest('base64url');
    const response = await app.request('/callback?state=identity-state&code=authorization-code', {
      headers: { cookie: `ticket_mailbox_oauth_state=identity_verification.${mac}` },
    });

    expect(response.status).toBe(400);
    expect(mocks.consumeConsentSession).not.toHaveBeenCalled();
    expect(mocks.exchangeMicrosoftAuthorizationCode).not.toHaveBeenCalled();
    expect(mocks.probeMailbox).not.toHaveBeenCalled();
    expect(mocks.bindVerifiedTenant).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['tampered', `identity_verification.${TENANT_ID}.invalid-signature`],
  ])('rejects a %s identity cookie before state or provider work', async (_label, cookie) => {
    const response = await app.request('/callback?state=identity-state&code=authorization-code', {
      headers: cookie ? { cookie: `ticket_mailbox_oauth_state=${cookie}` } : undefined,
    });

    expect(response.status).toBe(400);
    expect(mocks.consumeConsentSession).not.toHaveBeenCalled();
    expect(mocks.exchangeMicrosoftAuthorizationCode).not.toHaveBeenCalled();
    expect(mocks.verifyMicrosoftAdminIdToken).not.toHaveBeenCalled();
    expect(mocks.probeMailbox).not.toHaveBeenCalled();
    expect(mocks.bindVerifiedTenant).not.toHaveBeenCalled();
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
    expect(mocks.markPendingConsentFailed).toHaveBeenCalledWith(
      CONNECTION_ID, PARTNER_ID, ATTEMPT_ID, 'Mailbox verification failed',
    );
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
    mocks.markPendingConsentFailed.mockRejectedValue(new Error('database write detail'));
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
    ['pending_consent', TENANT_ID],
    ['disabled', TENANT_ID],
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
    expect(mocks.setConnectedMailboxStatus).not.toHaveBeenCalled();
    expect(mocks.restoreVerifiedConnection).not.toHaveBeenCalled();
    expect(mocks.writeRouteAudit).toHaveBeenCalledTimes(1);
    expect(mocks.writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'ticket_mailbox.retested',
      details: expect.objectContaining({ verifiedTenantId: TENANT_ID, outcome: 'verified' }),
    }));
  });

  it('allows a failed verified retest to succeed on retry without re-consent', async () => {
    mocks.setConnectedMailboxStatus.mockResolvedValue(true);
    mocks.restoreVerifiedConnection.mockResolvedValue(true);
    mocks.getMailboxConnection
      .mockResolvedValueOnce(connection({ status: 'connected' }))
      .mockResolvedValueOnce(connection({ status: 'error' }));
    mocks.probeMailbox
      .mockResolvedValueOnce({ ok: false, error: 'Graph leaked body' })
      .mockResolvedValueOnce({ ok: true });

    const failed = await app.request(`/connections/${CONNECTION_ID}/retest`, { method: 'POST' });
    const retried = await app.request(`/connections/${CONNECTION_ID}/retest`, { method: 'POST' });

    expect(failed.status).toBe(200);
    await expect(failed.json()).resolves.toEqual({ ok: false, error: 'Mailbox verification failed' });
    expect(retried.status).toBe(200);
    await expect(retried.json()).resolves.toEqual({ ok: true });
    expect(mocks.probeMailbox).toHaveBeenCalledTimes(2);
    expect(mocks.setConnectedMailboxStatus).toHaveBeenCalledWith(
      expect.objectContaining({ id: CONNECTION_ID, consentAttemptId: ATTEMPT_ID }),
      'error', 'Mailbox verification failed',
    );
    expect(mocks.restoreVerifiedConnection).toHaveBeenCalledWith(expect.objectContaining({
      id: CONNECTION_ID, partnerId: PARTNER_ID, tenantId: TENANT_ID,
      consentAttemptId: ATTEMPT_ID,
    }));
  });

  it('does not overwrite disable when a failed retest finishes after it', async () => {
    let finishProbe!: (value: { ok: false; error: string }) => void;
    mocks.probeMailbox.mockReturnValue(new Promise((resolve) => { finishProbe = resolve; }));
    mocks.setConnectedMailboxStatus.mockResolvedValue(false);

    const retest = app.request(`/connections/${CONNECTION_ID}/retest`, { method: 'POST' });
    await vi.waitFor(() => expect(mocks.probeMailbox).toHaveBeenCalledOnce());
    // disableConnection rotates the generation while the Graph probe is paused.
    finishProbe({ ok: false, error: 'Graph denied' });
    const response = await retest;

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: 'Mailbox connection changed during retest' });
    expect(mocks.writeRouteAudit).toHaveBeenCalledTimes(1);
    expect(mocks.writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'ticket_mailbox.retested',
      details: expect.objectContaining({ outcome: 'stale' }),
    }));
  });

  it('returns stale when disable wins during a successful connected retest with no transition', async () => {
    let finishProbe!: (value: { ok: true }) => void;
    mocks.probeMailbox.mockReturnValue(new Promise((resolve) => { finishProbe = resolve; }));
    mocks.isMailboxConnectionSnapshotCurrent.mockResolvedValue(false);

    const retest = app.request(`/connections/${CONNECTION_ID}/retest`, { method: 'POST' });
    await vi.waitFor(() => expect(mocks.probeMailbox).toHaveBeenCalledOnce());
    finishProbe({ ok: true });
    const response = await retest;

    expect(response.status).toBe(409);
    expect(mocks.isMailboxConnectionSnapshotCurrent).toHaveBeenCalledWith(
      expect.objectContaining({ id: CONNECTION_ID, consentAttemptId: ATTEMPT_ID }),
      'connected',
    );
    expect(mocks.writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      details: expect.objectContaining({ outcome: 'stale' }),
    }));
  });

  it('returns stale when generation rotates during a failed error retest with no transition', async () => {
    mocks.getMailboxConnection.mockResolvedValue(connection({ status: 'error' }));
    let finishProbe!: (value: { ok: false; error: string }) => void;
    mocks.probeMailbox.mockReturnValue(new Promise((resolve) => { finishProbe = resolve; }));
    mocks.isMailboxConnectionSnapshotCurrent.mockResolvedValue(false);

    const retest = app.request(`/connections/${CONNECTION_ID}/retest`, { method: 'POST' });
    await vi.waitFor(() => expect(mocks.probeMailbox).toHaveBeenCalledOnce());
    finishProbe({ ok: false, error: 'Graph denied' });
    const response = await retest;

    expect(response.status).toBe(409);
    expect(mocks.isMailboxConnectionSnapshotCurrent).toHaveBeenCalledWith(
      expect.objectContaining({ id: CONNECTION_ID, consentAttemptId: ATTEMPT_ID }),
      'error',
    );
    expect(mocks.writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      details: expect.objectContaining({ outcome: 'stale' }),
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

  it.each([
    [`/callback?state=admin-state&tenant=${TENANT_ID}&admin_consent=True&code=`, 'admin_consent'],
    [`/callback?state=admin-state&tenant=${TENANT_ID}&admin_consent=True&error=`, 'admin_consent'],
    [`/callback?state=admin-state&tenant=${TENANT_ID}&admin_consent=True&error_description=`, 'admin_consent'],
    ['/callback?state=identity-state&code=authorization-code&tenant=', 'identity_verification'],
    ['/callback?state=identity-state&code=authorization-code&admin_consent=', 'identity_verification'],
    ['/callback?state=identity-state&code=authorization-code&error=', 'identity_verification'],
    ['/callback?state=identity-state&code=authorization-code&error_description=', 'identity_verification'],
    ['/callback?state=identity-state&error=access_denied&code=', 'identity_verification'],
    ['/callback?state=identity-state&error=access_denied&tenant=', 'identity_verification'],
    ['/callback?state=identity-state&error=access_denied&admin_consent=', 'identity_verification'],
    ['/callback?state=identity-state&error_description=stray', 'identity_verification'],
    ['/callback?state=identity-state&error=&error_description=detail', 'identity_verification'],
  ])('rejects callback fields mixed by presence before consuming state: %s', async (path, phase) => {
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
