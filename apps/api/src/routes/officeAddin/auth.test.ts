import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// ── Mocks (vi.mock factories are hoisted — literals only) ────────────────────

const {
  verifyMock,
  findActiveBindingMock,
  hasAnyBindingMock,
  revokeBindingMock,
  findUserForBindMock,
  createBindingMock,
  BindingConflictErrorClass,
  mintTechSessionMock,
  resolveAndMintClientSessionMock,
  redisMock,
  getRedisMock,
  rateLimiterMock,
  writeAuditEventMock,
  verifyPasswordMock,
  hashPasswordMock,
  consumeMFATokenMock,
  decryptMfaSecretForMigrationMock,
  enableTwoFactorRef,
  assertActiveTenantContextMock,
  TenantInactiveErrorClass,
  getEffectiveMfaPolicyMock,
  reserveAccountAttemptMock,
  releaseAccountAttemptMock,
  notifyAccountLockedMock,
  assertPasswordAuthAllowedBySsoMock,
  SsoPasswordAuthRequiredErrorClass,
  enforceIpAllowlistMock,
  authResponseFloorPromiseMock,
} = vi.hoisted(() => {
  const redis = {
    setex: vi.fn(() => Promise.resolve('OK')),
    sadd: vi.fn(() => Promise.resolve(1)),
    expire: vi.fn(() => Promise.resolve(1)),
  };
  class BindingConflictErrorClass extends Error {}
  class TenantInactiveErrorClass extends Error {}
  return {
    verifyMock: vi.fn(),
    findActiveBindingMock: vi.fn(),
    hasAnyBindingMock: vi.fn(),
    revokeBindingMock: vi.fn(),
    findUserForBindMock: vi.fn(),
    createBindingMock: vi.fn(),
    BindingConflictErrorClass,
    mintTechSessionMock: vi.fn(),
    resolveAndMintClientSessionMock: vi.fn(),
    redisMock: redis,
    getRedisMock: vi.fn(() => redis),
    rateLimiterMock: vi.fn(() =>
      Promise.resolve({ allowed: true, remaining: 19, resetAt: new Date() })
    ),
    writeAuditEventMock: vi.fn(),
    verifyPasswordMock: vi.fn(),
    hashPasswordMock: vi.fn(() => Promise.resolve('dummy-hash')),
    consumeMFATokenMock: vi.fn(),
    decryptMfaSecretForMigrationMock: vi.fn(),
    enableTwoFactorRef: { current: true },
    assertActiveTenantContextMock: vi.fn(() => Promise.resolve()),
    TenantInactiveErrorClass,
    getEffectiveMfaPolicyMock: vi.fn(),
    reserveAccountAttemptMock: vi.fn(),
    releaseAccountAttemptMock: vi.fn(async () => undefined),
    notifyAccountLockedMock: vi.fn(async () => undefined),
    assertPasswordAuthAllowedBySsoMock: vi.fn(async () => undefined),
    SsoPasswordAuthRequiredErrorClass: class SsoPasswordAuthRequiredError extends Error {},
    enforceIpAllowlistMock: vi.fn(),
    authResponseFloorPromiseMock: vi.fn(() => Promise.resolve()),
  };
});

vi.mock('../../config/env', () => ({
  CLIENT_AI_ENTRA_CLIENT_ID: '00000000-aaaa-bbbb-cccc-000000000001',
}));

vi.mock('../../services/clientAiEntraJwt', () => {
  class ClientAiEntraInvalidTokenError extends Error {}
  class ClientAiEntraJwksUnavailableError extends Error {}
  return {
    verifyEntraIdToken: verifyMock,
    ClientAiEntraInvalidTokenError,
    ClientAiEntraJwksUnavailableError,
  };
});

vi.mock('../../db', () => ({
  withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('../../services/officeAddin/officeAddinBindings', async (importOriginal) => ({
  findActiveBinding: findActiveBindingMock,
  hasAnyBinding: hasAnyBindingMock,
  revokeBinding: revokeBindingMock,
  findUserForBind: findUserForBindMock,
  createBinding: createBindingMock,
  BindingConflictError: BindingConflictErrorClass,
  // The route now branches on the REAL vetBinding — pure logic, safe to use.
  vetBinding: (await importOriginal<typeof import('../../services/officeAddin/officeAddinBindings')>())
    .vetBinding,
}));

vi.mock('../../services/tenantStatus', () => ({
  assertActiveTenantContext: assertActiveTenantContextMock,
  TenantInactiveError: TenantInactiveErrorClass,
}));

vi.mock('../../services/password', () => ({
  getDummyPasswordHash: vi.fn(async () => 'dummy-hash'),
  verifyPassword: verifyPasswordMock,
  hashPassword: hashPasswordMock,
}));

vi.mock('../../services/mfa', () => ({
  consumeMFAToken: consumeMFATokenMock,
}));

vi.mock('../../services/mfaPolicy', () => ({
  getEffectiveMfaPolicy: getEffectiveMfaPolicyMock,
}));

vi.mock('../auth/helpers', () => ({
  decryptMfaSecretForMigration: decryptMfaSecretForMigrationMock,
  authResponseFloorPromise: authResponseFloorPromiseMock,
}));

vi.mock('../auth/schemas', () => ({
  get ENABLE_2FA() {
    return enableTwoFactorRef.current;
  },
}));

vi.mock('../../services/officeAddin/techSession', () => ({
  mintTechSession: mintTechSessionMock,
}));

vi.mock('../../services/clientAiExchange', () => ({
  resolveAndMintClientSession: resolveAndMintClientSessionMock,
}));

vi.mock('../../services/redis', () => ({ getRedis: getRedisMock }));
vi.mock('../../services/rate-limit', () => ({
  mfaLimiter: { limit: 5, windowSeconds: 300 },
  rateLimiter: rateLimiterMock,
  reserveAccountAttempt: reserveAccountAttemptMock,
  releaseAccountAttempt: releaseAccountAttemptMock,
}));
vi.mock('../auth/login', () => ({ notifyAccountLocked: notifyAccountLockedMock }));
vi.mock('../auth/ssoPolicy', () => ({
  assertPasswordAuthAllowedBySso: assertPasswordAuthAllowedBySsoMock,
  SsoPasswordAuthRequiredError: SsoPasswordAuthRequiredErrorClass,
}));
vi.mock('../../services/ipAllowlist', () => ({
  enforceIpAllowlist: enforceIpAllowlistMock,
  isBlocked: (decision: { decision: string }) => decision.decision === 'deny',
  IP_NOT_ALLOWED_BODY: { code: 'ip_not_allowed', error: 'Access denied from this IP address' },
}));
vi.mock('../../services/clientIp', async (importOriginal) => ({
  rateLimitIpKey: (await importOriginal<typeof import('../../services/clientIp')>()).rateLimitIpKey,
  getTrustedClientIp: vi.fn(() => '203.0.113.7'),
}));
vi.mock('../../services/auditEvents', () => ({ writeAuditEvent: writeAuditEventMock }));

import { officeAddinAuthRoutes } from './auth';
import {
  ClientAiEntraInvalidTokenError,
  ClientAiEntraJwksUnavailableError,
} from '../../services/clientAiEntraJwt';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TID = '6f4f4f4f-1111-4222-8333-444455556666';
const OID = '7a7a7a7a-2222-4333-8444-555566667777';
const USER_ID = 'beefbeef-1111-4222-8333-444455556666';
const PARTNER_ID = 'a1a1a1a1-1111-4222-8333-444455556666';
const BINDING_ID = 'c0c0c0c0-1111-4222-8333-444455556666';

const CLAIMS = {
  tid: TID,
  oid: OID,
  email: 'tech@msp.example.com',
  name: 'Tech User',
  aud: '00000000-aaaa-bbbb-cccc-000000000001',
  iss: `https://login.microsoftonline.com/${TID}/v2.0`,
  exp: Math.floor(Date.now() / 1000) + 600,
  iat: Math.floor(Date.now() / 1000),
  scp: 'access_as_user',
};

const ELIGIBLE_BOUND = {
  binding: {
    id: BINDING_ID,
    userId: USER_ID,
    partnerId: PARTNER_ID,
    boundAuthEpoch: 1,
    boundMfaEpoch: 1,
    mfaVerifiedAt: new Date(),
  },
  user: {
    id: USER_ID,
    email: 'tech@msp.example.com',
    name: 'Tech User',
    status: 'active',
    authEpoch: 1,
    mfaEpoch: 1,
    partnerId: PARTNER_ID,
  },
};

const CLIENT_RESOLVED_OUTCOME = {
  kind: 'resolved' as const,
  body: {
    accessToken: 'client-token-123',
    expiresInSeconds: 86400,
    user: { id: 'client-user-1', email: 'client@contoso.com', name: 'Client User' },
    org: { id: 'org-1' },
    branding: { displayName: null, logoUrl: null },
  },
  audit: {
    orgId: 'org-1',
    result: 'success' as const,
    actorId: 'client-user-1',
    actorEmail: 'client@contoso.com',
    details: {},
  },
};

const CLIENT_DENIED_OUTCOME = {
  kind: 'denied' as const,
  status: 404 as const,
  body: { error: 'tenant_not_provisioned' },
  audit: {
    orgId: null,
    result: 'denied' as const,
    actorEmail: null,
    details: { reason: 'tenant_not_provisioned' },
  },
};

const BIND_USER = {
  id: USER_ID,
  email: 'tech@msp.example.com',
  name: 'Tech User',
  status: 'active',
  partnerId: PARTNER_ID,
  passwordHash: 'argon2-hash',
  isPlatformAdmin: false,
  mfaEnabled: true,
  mfaMethod: 'totp',
  mfaSecret: 'encrypted-secret',
  authEpoch: 1,
  mfaEpoch: 7,
};

function buildApp() {
  const app = new Hono();
  // Mirrors ./index.ts: the auth router registers '/exchange' and '/bind' and
  // is mounted under '/auth', keeping the external paths unchanged.
  app.route('/office-addin/auth', officeAddinAuthRoutes);
  return app;
}

function postExchange(app: Hono, accessToken = 'entra-token') {
  return app.request('/office-addin/auth/exchange', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken }),
  });
}

function postBind(
  app: Hono,
  body: Partial<{ accessToken: string; email: string; password: string; mfaCode: string }> = {}
) {
  return app.request('/office-addin/auth/bind', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      accessToken: 'entra-token',
      email: 'tech@msp.example.com',
      password: 'correct-horse-battery-staple',
      mfaCode: '123456',
      ...body,
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getRedisMock.mockReturnValue(redisMock);
  rateLimiterMock.mockResolvedValue({ allowed: true, remaining: 19, resetAt: new Date() });
  verifyMock.mockResolvedValue(CLAIMS);
  findActiveBindingMock.mockResolvedValue(null);
  hasAnyBindingMock.mockResolvedValue(false);
  mintTechSessionMock.mockResolvedValue({ token: 'tech-token-123', expiresInSeconds: 43200 });
  resolveAndMintClientSessionMock.mockResolvedValue(CLIENT_RESOLVED_OUTCOME);

  enableTwoFactorRef.current = true;
  findUserForBindMock.mockResolvedValue({ ...BIND_USER });
  verifyPasswordMock.mockResolvedValue(true);
  consumeMFATokenMock.mockResolvedValue(true);
  decryptMfaSecretForMigrationMock.mockReturnValue({ plaintext: 'TOTPSECRET', migratedSecret: null });
  createBindingMock.mockResolvedValue({ id: BINDING_ID });
  hashPasswordMock.mockResolvedValue('dummy-hash');
  assertActiveTenantContextMock.mockResolvedValue(undefined);
  reserveAccountAttemptMock.mockResolvedValue({ allowed: true, count: 1, reachesLimit: false });
  assertPasswordAuthAllowedBySsoMock.mockResolvedValue(undefined);
  enforceIpAllowlistMock.mockResolvedValue({ decision: 'allow' });
  authResponseFloorPromiseMock.mockImplementation(() => Promise.resolve());
  getEffectiveMfaPolicyMock.mockResolvedValue({
    required: true,
    allowedMethods: { totp: true, sms: true, passkey: true },
    pendingEnrollment: null,
    source: { roleForceMfa: true, settingsRequireMfa: false, killSwitchOff: false, graceWindow: 'none' as const },
  });
});

// ── Tests: the exchange matrix (spec §9) ────────────────────────────────────

describe('POST /office-addin/auth/exchange', () => {
  it('1. no binding → resolveAndMintClientSession called; response = client body + persona:client', async () => {
    findActiveBindingMock.mockResolvedValue(null);
    hasAnyBindingMock.mockResolvedValue(false);
    const res = await postExchange(buildApp());
    expect(resolveAndMintClientSessionMock).toHaveBeenCalledWith(CLAIMS, redisMock);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ persona: 'client', ...CLIENT_RESOLVED_OUTCOME.body });
    expect(mintTechSessionMock).not.toHaveBeenCalled();
  });

  it('2. bound + eligible → persona:tech, tech session minted, client resolver NOT called', async () => {
    findActiveBindingMock.mockResolvedValue(ELIGIBLE_BOUND);
    const res = await postExchange(buildApp());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      persona: 'tech',
      accessToken: 'tech-token-123',
      expiresInSeconds: 43200,
      user: { id: USER_ID, email: 'tech@msp.example.com', name: 'Tech User' },
      partner: { id: PARTNER_ID },
    });
    expect(mintTechSessionMock).toHaveBeenCalledWith(redisMock, {
      userId: USER_ID,
      partnerId: PARTNER_ID,
      bindingId: BINDING_ID,
    });
    expect(resolveAndMintClientSessionMock).not.toHaveBeenCalled();
    expect(writeAuditEventMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'office_addin.auth.exchange',
        result: 'success',
        actorId: USER_ID,
      })
    );
  });

  it('3. bound + user inactive → 403 binding_denied/user_inactive; client resolver NOT called', async () => {
    findActiveBindingMock.mockResolvedValue({
      ...ELIGIBLE_BOUND,
      user: { ...ELIGIBLE_BOUND.user, status: 'disabled' },
    });
    const res = await postExchange(buildApp());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'binding_denied', reason: 'user_inactive' });
    expect(resolveAndMintClientSessionMock).not.toHaveBeenCalled();
    expect(revokeBindingMock).not.toHaveBeenCalled();
  });

  it('4. revoked-only binding (hasAnyBinding true, findActiveBinding null) → 403 binding_denied/revoked_relink; client resolver NOT called', async () => {
    findActiveBindingMock.mockResolvedValue(null);
    hasAnyBindingMock.mockResolvedValue(true);
    const res = await postExchange(buildApp());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'binding_denied', reason: 'revoked_relink' });
    expect(resolveAndMintClientSessionMock).not.toHaveBeenCalled();
  });

  it('5. bound + authEpoch mismatch → 403 binding_denied/epoch_advanced AND revokeBinding called', async () => {
    findActiveBindingMock.mockResolvedValue({
      ...ELIGIBLE_BOUND,
      user: { ...ELIGIBLE_BOUND.user, authEpoch: 2 },
    });
    const res = await postExchange(buildApp());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'binding_denied', reason: 'epoch_advanced' });
    expect(revokeBindingMock).toHaveBeenCalledWith(BINDING_ID, null);
    expect(resolveAndMintClientSessionMock).not.toHaveBeenCalled();
  });

  it('bound + partner mismatch → 403 binding_denied/membership_revoked', async () => {
    findActiveBindingMock.mockResolvedValue({
      ...ELIGIBLE_BOUND,
      user: { ...ELIGIBLE_BOUND.user, partnerId: 'ffffffff-1111-4222-8333-444455556666' },
    });
    const res = await postExchange(buildApp());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'binding_denied', reason: 'membership_revoked' });
    expect(revokeBindingMock).not.toHaveBeenCalled();
  });

  it('bound + eligible but partner tenant inactive → 403 binding_denied/tenant_inactive, no session minted', async () => {
    findActiveBindingMock.mockResolvedValue(ELIGIBLE_BOUND);
    assertActiveTenantContextMock.mockRejectedValue(new TenantInactiveErrorClass('nope'));
    const res = await postExchange(buildApp());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'binding_denied', reason: 'tenant_inactive' });
    expect(assertActiveTenantContextMock).toHaveBeenCalledWith({
      scope: 'partner',
      partnerId: PARTNER_ID,
      orgId: null,
    });
    expect(mintTechSessionMock).not.toHaveBeenCalled();
    expect(resolveAndMintClientSessionMock).not.toHaveBeenCalled();
  });

  it('6. token missing scp access_as_user → 401 invalid_token (checked before binding lookup)', async () => {
    verifyMock.mockResolvedValue({ ...CLAIMS, scp: 'other_scope' });
    const res = await postExchange(buildApp());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid_token' });
    expect(findActiveBindingMock).not.toHaveBeenCalled();
    expect(resolveAndMintClientSessionMock).not.toHaveBeenCalled();
  });

  it('6b. token with null scp → 401 invalid_token', async () => {
    verifyMock.mockResolvedValue({ ...CLAIMS, scp: null });
    const res = await postExchange(buildApp());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid_token' });
  });

  it('401s on an invalid Entra token', async () => {
    verifyMock.mockRejectedValue(new ClientAiEntraInvalidTokenError('bad'));
    const res = await postExchange(buildApp());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid_token' });
  });

  it('503s when Microsoft JWKS is unreachable', async () => {
    verifyMock.mockRejectedValue(new ClientAiEntraJwksUnavailableError('down'));
    const res = await postExchange(buildApp());
    expect(res.status).toBe(503);
  });

  it('7. rate limit exceeded → 429', async () => {
    rateLimiterMock.mockResolvedValue({ allowed: false, remaining: 0, resetAt: new Date() });
    const res = await postExchange(buildApp());
    expect(res.status).toBe(429);
  });

  it('503s when Redis is unavailable', async () => {
    getRedisMock.mockReturnValue(null as never);
    const res = await postExchange(buildApp());
    expect(res.status).toBe(503);
  });

  it('400s on a missing accessToken body field', async () => {
    const app = buildApp();
    const res = await app.request('/office-addin/auth/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('8. dual-mapped tenant (binding exists AND client tenant mapping exists) → binding wins → tech', async () => {
    findActiveBindingMock.mockResolvedValue(ELIGIBLE_BOUND);
    // Even though a client-ai tenant mapping would resolve for this tenant,
    // the binding must win and the client resolver must never be consulted.
    const res = await postExchange(buildApp());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.persona).toBe('tech');
    expect(resolveAndMintClientSessionMock).not.toHaveBeenCalled();
  });

  it('denies binding_denied paths and audits with result denied', async () => {
    findActiveBindingMock.mockResolvedValue({
      ...ELIGIBLE_BOUND,
      user: { ...ELIGIBLE_BOUND.user, status: 'disabled' },
    });
    await postExchange(buildApp());
    expect(writeAuditEventMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'office_addin.auth.exchange',
        result: 'denied',
        details: expect.objectContaining({ reason: 'user_inactive' }),
      })
    );
  });
});

// ── Tests: the bind flow (spec §9, Task 11) ─────────────────────────────────

describe('POST /office-addin/auth/bind', () => {
  it('valid entra token + valid credentials + valid TOTP → binding created → 200 bound:true', async () => {
    const res = await postBind(buildApp());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ bound: true });
    expect(createBindingMock).toHaveBeenCalledWith({
      entraTenantId: TID,
      entraOid: OID,
      userId: USER_ID,
      partnerId: PARTNER_ID,
      boundAuthEpoch: 1,
      boundMfaEpoch: 7,
      mfaVerifiedAt: expect.any(Date),
    });
    expect(writeAuditEventMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'office_addin.binding.created',
        result: 'success',
        actorId: USER_ID,
      })
    );
  });

  it('wrong password → 401 invalid_credentials, no binding created', async () => {
    verifyPasswordMock.mockResolvedValue(false);
    const res = await postBind(buildApp());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid_credentials' });
    expect(createBindingMock).not.toHaveBeenCalled();
  });

  it('user not found → 401 invalid_credentials (same body as wrong password; dummy hash verified)', async () => {
    findUserForBindMock.mockResolvedValue(null);
    const res = await postBind(buildApp());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid_credentials' });
    expect(verifyPasswordMock).toHaveBeenCalledWith('dummy-hash', 'correct-horse-battery-staple');
    expect(createBindingMock).not.toHaveBeenCalled();
  });

  it('user not active → 401 invalid_credentials', async () => {
    findUserForBindMock.mockResolvedValue({ ...BIND_USER, status: 'disabled' });
    const res = await postBind(buildApp());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid_credentials' });
  });

  it('ENABLE_2FA on + user has no MFA enrolled → 403 mfa_enrollment_required', async () => {
    findUserForBindMock.mockResolvedValue({ ...BIND_USER, mfaEnabled: false, mfaSecret: null });
    const res = await postBind(buildApp());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'mfa_enrollment_required' });
    expect(createBindingMock).not.toHaveBeenCalled();
  });

  it('wrong TOTP → 401 invalid_mfa', async () => {
    consumeMFATokenMock.mockResolvedValue(false);
    const res = await postBind(buildApp());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid_mfa' });
    expect(createBindingMock).not.toHaveBeenCalled();
  });

  it('policy-prohibited TOTP is rejected before code consumption or binding creation', async () => {
    getEffectiveMfaPolicyMock.mockResolvedValue({
      required: true,
      allowedMethods: { totp: false, sms: true, passkey: true },
      pendingEnrollment: null,
      source: { roleForceMfa: false, settingsRequireMfa: true, killSwitchOff: false, graceWindow: 'none' as const },
    });

    const res = await postBind(buildApp());

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'mfa_method_not_allowed' });
    expect(getEffectiveMfaPolicyMock).toHaveBeenCalledWith({
      scope: 'partner',
      userId: USER_ID,
      orgId: null,
      partnerId: PARTNER_ID,
    }, { failClosedMethods: true });
    expect(consumeMFATokenMock).not.toHaveBeenCalled();
    expect(createBindingMock).not.toHaveBeenCalled();
  });

  it('a lingering TOTP secret is rejected when TOTP is not the active factor', async () => {
    findUserForBindMock.mockResolvedValue({ ...BIND_USER, mfaMethod: 'sms' });

    const res = await postBind(buildApp());

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'mfa_enrollment_required' });
    expect(getEffectiveMfaPolicyMock).not.toHaveBeenCalled();
    expect(consumeMFATokenMock).not.toHaveBeenCalled();
    expect(createBindingMock).not.toHaveBeenCalled();
  });

  // #10650 Decision 3A: the authenticator-app backup beside a primary passkey
  // is the same factor at login, so it binds the add-in too.
  it('passkey primary + backup authenticator app + valid TOTP → binding created', async () => {
    findUserForBindMock.mockResolvedValue({ ...BIND_USER, mfaMethod: 'passkey' });

    const res = await postBind(buildApp());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ bound: true });
    expect(consumeMFATokenMock).toHaveBeenCalled();
    expect(createBindingMock).toHaveBeenCalled();
  });

  it('passkey primary without an authenticator app → 403 mfa_enrollment_required', async () => {
    findUserForBindMock.mockResolvedValue({ ...BIND_USER, mfaMethod: 'passkey', mfaSecret: null });

    const res = await postBind(buildApp());

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'mfa_enrollment_required' });
    expect(consumeMFATokenMock).not.toHaveBeenCalled();
    expect(createBindingMock).not.toHaveBeenCalled();
  });

  it('MFA secret fails to decrypt → 401 invalid_mfa', async () => {
    decryptMfaSecretForMigrationMock.mockReturnValue({ plaintext: null, migratedSecret: null });
    const res = await postBind(buildApp());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid_mfa' });
    expect(consumeMFATokenMock).not.toHaveBeenCalled();
  });

  it('(tid,oid) already actively bound to a DIFFERENT user → 409 identity_already_bound', async () => {
    createBindingMock.mockRejectedValue(new BindingConflictErrorClass());
    const res = await postBind(buildApp());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'identity_already_bound' });
  });

  it('same user re-binding (new Entra tenant) → createBinding called (revoke-then-insert lives in the service) → 200', async () => {
    const res = await postBind(buildApp());
    expect(res.status).toBe(200);
    expect(createBindingMock).toHaveBeenCalledTimes(1);
  });

  it('suspended/churned partner → the same 401 invalid_credentials as a wrong password, no binding created', async () => {
    assertActiveTenantContextMock.mockRejectedValue(new TenantInactiveErrorClass('nope'));
    const res = await postBind(buildApp());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid_credentials' });
    expect(writeAuditEventMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ result: 'denied', details: expect.objectContaining({ reason: 'tenant_inactive' }) }),
    );
    expect(assertActiveTenantContextMock).toHaveBeenCalledWith({
      scope: 'partner',
      partnerId: PARTNER_ID,
      orgId: null,
    });
    expect(createBindingMock).not.toHaveBeenCalled();
  });

  it('user with partner_id null (org-only user) → the same 401 invalid_credentials as a wrong password', async () => {
    findUserForBindMock.mockResolvedValue({ ...BIND_USER, partnerId: null });
    const res = await postBind(buildApp());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid_credentials' });
    expect(writeAuditEventMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ result: 'denied', details: expect.objectContaining({ reason: 'not_a_technician' }) }),
    );
    expect(createBindingMock).not.toHaveBeenCalled();
  });

  describe('per-account sign-in lockout (shared with /auth/login)', () => {
    it('reserves the attempt on the account before checking the password', async () => {
      const order: string[] = [];
      reserveAccountAttemptMock.mockImplementationOnce(async () => {
        order.push('reserve');
        return { allowed: true, count: 1, reachesLimit: false };
      });
      verifyPasswordMock.mockImplementationOnce(async () => {
        order.push('verify');
        return false;
      });

      const res = await postBind(buildApp(), { email: 'Tech@MSP.example.com' });

      expect(res.status).toBe(401);
      expect(order).toEqual(['reserve', 'verify']);
      expect(reserveAccountAttemptMock).toHaveBeenCalledWith(expect.anything(), 'tech@msp.example.com');
      expect(releaseAccountAttemptMock).not.toHaveBeenCalled();
      expect(notifyAccountLockedMock).not.toHaveBeenCalled();
    });

    it('refuses a locked account with the same 401, after the same password check, even with the right password', async () => {
      reserveAccountAttemptMock.mockResolvedValueOnce({ allowed: false, count: 6, reachesLimit: false });

      const res = await postBind(buildApp());

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'invalid_credentials' });
      expect(verifyPasswordMock).toHaveBeenCalledWith('argon2-hash', 'correct-horse-battery-staple');
      expect(releaseAccountAttemptMock).not.toHaveBeenCalled();
      expect(consumeMFATokenMock).not.toHaveBeenCalled();
      expect(createBindingMock).not.toHaveBeenCalled();
    });

    it('sends the lockout notice when a wrong password is the attempt that reaches the limit', async () => {
      reserveAccountAttemptMock.mockResolvedValueOnce({ allowed: true, count: 5, reachesLimit: true });
      verifyPasswordMock.mockResolvedValueOnce(false);

      await postBind(buildApp());

      expect(notifyAccountLockedMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ id: USER_ID, email: 'tech@msp.example.com' }),
        5,
      );
      expect(releaseAccountAttemptMock).not.toHaveBeenCalled();
    });

    it('gives the attempt back after a correct password', async () => {
      await postBind(buildApp());

      expect(releaseAccountAttemptMock).toHaveBeenCalledWith(expect.anything(), 'tech@msp.example.com');
    });

    it('does not count attempts for an unknown, inactive or passwordless (SSO-only) account', async () => {
      findUserForBindMock.mockResolvedValueOnce(null);
      const unknown = await postBind(buildApp());
      findUserForBindMock.mockResolvedValueOnce({ ...BIND_USER, status: 'disabled' });
      const inactive = await postBind(buildApp());
      findUserForBindMock.mockResolvedValueOnce({ ...BIND_USER, passwordHash: null });
      const passwordless = await postBind(buildApp());

      for (const res of [unknown, inactive, passwordless]) {
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: 'invalid_credentials' });
      }
      expect(reserveAccountAttemptMock).not.toHaveBeenCalled();
      // Equal work: a dummy password check runs instead.
      expect(verifyPasswordMock).toHaveBeenCalledTimes(3);
      expect(verifyPasswordMock).toHaveBeenLastCalledWith('dummy-hash', 'correct-horse-battery-staple');
    });

    it('limits verification codes per account the way sign-in does, before checking the code', async () => {
      // The mock is declared without parameters; this one routes by key.
      const byKey = async (_redis: unknown, key: string) =>
        key.startsWith('mfa:')
          ? { allowed: false, remaining: 0, resetAt: new Date() }
          : { allowed: true, remaining: 19, resetAt: new Date() };
      rateLimiterMock.mockImplementation(byKey as unknown as () => ReturnType<typeof byKey>);

      const res = await postBind(buildApp());

      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({ error: 'rate_limited' });
      expect(rateLimiterMock).toHaveBeenCalledWith(expect.anything(), `mfa:${USER_ID}`, 5, 300);
      expect(consumeMFATokenMock).not.toHaveBeenCalled();
      expect(createBindingMock).not.toHaveBeenCalled();
    });
  });

  describe('minimum response time (as /auth/login)', () => {
    it.each([
      ['an unknown account', () => findUserForBindMock.mockResolvedValueOnce(null)],
      ['a suspended partner', () => assertActiveTenantContextMock.mockRejectedValueOnce(new TenantInactiveErrorClass('nope'))],
      ['a partner that requires SSO', () => assertPasswordAuthAllowedBySsoMock.mockRejectedValueOnce(new SsoPasswordAuthRequiredErrorClass())],
      ['a successful link', () => undefined],
    ])('holds the answer for %s until the shared floor elapses', async (_label, arrange) => {
      arrange();
      let releaseFloor!: () => void;
      authResponseFloorPromiseMock.mockImplementationOnce(() => new Promise<void>((resolve) => { releaseFloor = resolve; }));
      let settled = false;

      const pending = Promise.resolve(postBind(buildApp())).then((res: Response) => { settled = true; return res; });
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(authResponseFloorPromiseMock).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
      releaseFloor();
      expect((await pending).status).toBeGreaterThanOrEqual(200);
      expect(settled).toBe(true);
    });
  });

  describe('account state is revealed only after the checks /auth/login makes', () => {
    it('a partner that requires SSO gets the same 401 invalid_credentials, no binding', async () => {
      assertPasswordAuthAllowedBySsoMock.mockRejectedValueOnce(new SsoPasswordAuthRequiredErrorClass());

      const res = await postBind(buildApp());

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'invalid_credentials' });
      expect(assertPasswordAuthAllowedBySsoMock).toHaveBeenCalledWith({ scope: 'partner', partnerId: PARTNER_ID, orgId: null });
      expect(consumeMFATokenMock).not.toHaveBeenCalled();
      expect(createBindingMock).not.toHaveBeenCalled();
    });

    it('a request from outside the partner IP allowlist gets 403 ip_not_allowed before any MFA state', async () => {
      enforceIpAllowlistMock.mockResolvedValueOnce({ decision: 'deny', reason: 'not_in_list' });
      findUserForBindMock.mockResolvedValueOnce({ ...BIND_USER, mfaEnabled: false, mfaSecret: null });

      const res = await postBind(buildApp());

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'ip_not_allowed' });
      expect(enforceIpAllowlistMock).toHaveBeenCalledWith(expect.anything(), {
        partnerId: PARTNER_ID,
        isPlatformAdmin: false,
        actorId: USER_ID,
        actorEmail: 'tech@msp.example.com',
      });
      expect(createBindingMock).not.toHaveBeenCalled();
    });

    it('an allowlist lookup failure gets the same 401 invalid_credentials, as at sign-in', async () => {
      enforceIpAllowlistMock.mockRejectedValueOnce(new Error('settings read failed'));

      const res = await postBind(buildApp());

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'invalid_credentials' });
      expect(createBindingMock).not.toHaveBeenCalled();
    });

    it('a wrong password never reaches the account, tenant, policy or network checks', async () => {
      verifyPasswordMock.mockResolvedValueOnce(false);

      await postBind(buildApp());

      expect(assertActiveTenantContextMock).not.toHaveBeenCalled();
      expect(assertPasswordAuthAllowedBySsoMock).not.toHaveBeenCalled();
      expect(enforceIpAllowlistMock).not.toHaveBeenCalled();
    });
  });

  it('missing scp access_as_user → 401 invalid_token (checked before any credential work)', async () => {
    verifyMock.mockResolvedValue({ ...CLAIMS, scp: 'other_scope' });
    const res = await postBind(buildApp());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid_token' });
    expect(findUserForBindMock).not.toHaveBeenCalled();
  });

  it('rate limit (10 / 15 min per IP) exceeded → 429', async () => {
    rateLimiterMock.mockResolvedValue({ allowed: false, remaining: 0, resetAt: new Date() });
    const res = await postBind(buildApp());
    expect(res.status).toBe(429);
    expect(rateLimiterMock).toHaveBeenCalledWith(
      redisMock,
      expect.stringContaining('officeaddin-bind-'),
      10,
      900
    );
  });

  it('ENABLE_2FA off → skips MFA verification (dev mode) → 200', async () => {
    enableTwoFactorRef.current = false;
    findUserForBindMock.mockResolvedValue({ ...BIND_USER, mfaEnabled: false, mfaSecret: null });
    const res = await postBind(buildApp());
    expect(res.status).toBe(200);
    expect(consumeMFATokenMock).not.toHaveBeenCalled();
    expect(createBindingMock).toHaveBeenCalled();
  });

  it('400s on a missing mfaCode body field', async () => {
    const app = buildApp();
    const res = await app.request('/office-addin/auth/bind', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken: 'entra-token', email: 'tech@msp.example.com', password: 'x' }),
    });
    expect(res.status).toBe(400);
  });

  it('503s when Redis is unavailable', async () => {
    getRedisMock.mockReturnValue(null as never);
    const res = await postBind(buildApp());
    expect(res.status).toBe(503);
  });

  it('401s on an invalid Entra token', async () => {
    verifyMock.mockRejectedValue(new ClientAiEntraInvalidTokenError('bad'));
    const res = await postBind(buildApp());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid_token' });
  });
});
