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
} = vi.hoisted(() => {
  const redis = {
    setex: vi.fn(() => Promise.resolve('OK')),
    sadd: vi.fn(() => Promise.resolve(1)),
    expire: vi.fn(() => Promise.resolve(1)),
  };
  class BindingConflictErrorClass extends Error {}
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

vi.mock('../../services/officeAddin/officeAddinBindings', () => ({
  findActiveBinding: findActiveBindingMock,
  hasAnyBinding: hasAnyBindingMock,
  revokeBinding: revokeBindingMock,
  findUserForBind: findUserForBindMock,
  createBinding: createBindingMock,
  BindingConflictError: BindingConflictErrorClass,
}));

vi.mock('../../services/password', () => ({
  verifyPassword: verifyPasswordMock,
  hashPassword: hashPasswordMock,
}));

vi.mock('../../services/mfa', () => ({
  consumeMFAToken: consumeMFATokenMock,
}));

vi.mock('../auth/helpers', () => ({
  decryptMfaSecretForMigration: decryptMfaSecretForMigrationMock,
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
vi.mock('../../services/rate-limit', () => ({ rateLimiter: rateLimiterMock }));
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
    mfaVerifiedAt: new Date(),
  },
  user: {
    id: USER_ID,
    email: 'tech@msp.example.com',
    name: 'Tech User',
    status: 'active',
    authEpoch: 1,
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
  mfaEnabled: true,
  mfaSecret: 'encrypted-secret',
  authEpoch: 1,
};

function buildApp() {
  const app = new Hono();
  app.route('/office-addin', officeAddinAuthRoutes);
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

  it('user with partner_id null (org-only user) → 403 not_a_technician', async () => {
    findUserForBindMock.mockResolvedValue({ ...BIND_USER, partnerId: null });
    const res = await postBind(buildApp());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'not_a_technician' });
    expect(createBindingMock).not.toHaveBeenCalled();
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
