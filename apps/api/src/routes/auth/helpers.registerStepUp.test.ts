import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AuthContext } from '../../middleware/auth';

// A8: ENABLE_2FA=false escape hatch for userHasStrongerReauthFactor. Mutable
// flag so individual tests can flip the flag without a per-test module
// re-import — mirrors the enable2faState pattern in login.test.ts.
const enable2faState = vi.hoisted(() => ({ value: true }));

// --- Mocks must be declared before importing the unit under test ---
// Mirrors the vi.hoisted/vi.mock harness in helpers.mfaStepUp.test.ts, extended
// with getUserEpochs (../../services) and mfaStepUpGrant (validateStepUpGrant /
// consumeStepUpGrant) since enforceApproverRegisterStepUp exercises both.
const {
  selectLimit,
  db,
  getRedis,
  rateLimiter,
  consumeMFAToken,
  decryptMfaTotpSecret,
  getUserEpochs,
  validateStepUpGrant,
  consumeStepUpGrant,
} = vi.hoisted(() => {
  const selectLimit = vi.fn();
  const db = {
    // db.select(...).from(...).where(...).limit(...) chain returning the mocked user row.
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: selectLimit,
        })),
      })),
    })),
  };
  return {
    selectLimit,
    db,
    getRedis: vi.fn(),
    rateLimiter: vi.fn(),
    consumeMFAToken: vi.fn(),
    decryptMfaTotpSecret: vi.fn(),
    getUserEpochs: vi.fn(),
    validateStepUpGrant: vi.fn(),
    consumeStepUpGrant: vi.fn(),
  };
});

vi.mock('../../db', () => ({
  db,
  withSystemDbAccessContext: undefined,
}));

vi.mock('../../db/schema', () => ({
  users: { id: 'id', mfaEnabled: 'mfa_enabled', mfaSecret: 'mfa_secret', mfaMethod: 'mfa_method' },
  partnerUsers: {},
  organizationUsers: {},
  organizations: {},
}));

vi.mock('../../services', () => ({
  verifyToken: vi.fn(),
  isUserTokenRevoked: vi.fn(),
  revokeRefreshTokenJti: vi.fn(),
  getTrustedClientIp: vi.fn(() => 'unknown'),
  getRedis,
  rateLimiter,
  verifyPassword: vi.fn(),
  getUserEpochs,
}));

vi.mock('../../services/mfa', () => ({
  consumeMFAToken,
}));

vi.mock('../../services/mfaSecretCrypto', () => ({
  decryptMfaTotpSecret,
  decryptMfaTotpSecretForMigration: vi.fn(),
  encryptMfaTotpSecret: vi.fn(),
}));

vi.mock('../../services/mfaStepUpGrant', () => ({
  validateStepUpGrant,
  consumeStepUpGrant,
}));

vi.mock('../../services/auditService', () => ({ createAuditLogAsync: vi.fn() }));
vi.mock('../../services/anomalyMetrics', () => ({ recordFailedLogin: vi.fn() }));
vi.mock('../../services/corsOrigins', () => ({
  DEFAULT_ALLOWED_ORIGINS: [],
  shouldIncludeDefaultOrigins: vi.fn(() => false),
}));
vi.mock('../../services/tenantStatus', () => ({ assertActiveTenantContext: vi.fn() }));

// A8: real ./schemas module, but ENABLE_2FA is overridden via a live getter so
// individual tests can toggle it (this file does NOT mock the './helpers'
// module itself — enforceApproverRegisterStepUp/userHasStrongerReauthFactor
// run for real, and userHasStrongerReauthFactor reads ENABLE_2FA from here).
vi.mock('./schemas', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./schemas')>();
  return {
    ...actual,
    get ENABLE_2FA() {
      return enable2faState.value;
    },
  };
});

import { enforceApproverRegisterStepUp, userHasStrongerReauthFactor } from './helpers';
import { createAuditLogAsync } from '../../services/auditService';

// Minimal Hono Context stub. c.json is exercised by every helper under test;
// c.req.header is additionally needed now that the 403 deny path audits via
// writeAuthAudit (A4), which reads c.req.header('user-agent') directly.
function ctx() {
  const json = vi.fn((body: unknown, status?: number) => ({
    __body: body,
    __status: status ?? 200,
    json: async () => body,
    status: status ?? 200,
  }));
  const req = { header: vi.fn(() => undefined) };
  return { json, req } as any;
}

const USER_ID = 'user-1';

// Minimal AuthContext stub: only auth.user.id and auth.token.sid are read by
// enforceApproverRegisterStepUp. The remaining required fields are stubbed
// with values that are never exercised by the helper under test.
function authCtx(tokenOverrides: { sid?: string } = {}): AuthContext {
  return {
    user: { id: USER_ID, email: 'user@example.com', name: 'Test User', isPlatformAdmin: false },
    token: {
      sub: USER_ID,
      email: 'user@example.com',
      roleId: null,
      orgId: null,
      partnerId: null,
      scope: 'organization',
      type: 'access',
      mfa: false,
      sid: tokenOverrides.sid,
    },
    partnerId: null,
    orgId: null,
    scope: 'organization',
    accessibleOrgIds: null,
    orgCondition: () => undefined,
    canAccessOrg: () => true,
  } as unknown as AuthContext;
}

// Queue-based stand-in for sequential db.select(...).limit() resolutions, used
// by the userHasStrongerReauthFactor it.each cases (each case pushes exactly
// one row's worth of results before invoking the helper once).
const dbState = { selectQueue: [] as unknown[][] };

const grantMocks = { validateStepUpGrant, consumeStepUpGrant };
const epochsMock = { getUserEpochs };

describe('enforceApproverRegisterStepUp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.selectQueue = [];
    selectLimit.mockImplementation(() => Promise.resolve(dbState.selectQueue.shift() ?? []));
  });

  it('403s a NON-MFA-protected user with no grant (no bypass — the spec pin)', async () => {
    // arrange: userIsMfaProtected-style state irrelevant — helper must not consult it.
    grantMocks.validateStepUpGrant.mockResolvedValue(false);
    epochsMock.getUserEpochs.mockResolvedValue({ authEpoch: 1, mfaEpoch: 1 });
    const res = await enforceApproverRegisterStepUp(ctx(), authCtx({ sid: 'sid-1' }), undefined, { consume: false });
    expect(res?.status).toBe(403);
    expect(await res!.json()).toEqual({ error: 'register_step_up_required' });
  });

  // A4 (review finding): a deny must be audited — this is the only signal an
  // operator gets that someone tried to register an approver key without a
  // valid grant. Assert on the real writeAuthAudit -> createAuditLogAsync
  // call (this file does not mock ./helpers, so enforceApproverRegisterStepUp
  // is the real implementation).
  it('audits the 403 deny as a failure event, recording only whether a grantId was present', async () => {
    grantMocks.validateStepUpGrant.mockResolvedValue(false);
    epochsMock.getUserEpochs.mockResolvedValue({ authEpoch: 1, mfaEpoch: 1 });
    const res = await enforceApproverRegisterStepUp(ctx(), authCtx({ sid: 'sid-1' }), 'stale-grant', { consume: false });
    expect(res?.status).toBe(403);
    expect(createAuditLogAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.authenticator.register.denied',
        result: 'failure',
        details: expect.objectContaining({ reason: 'register_step_up_required', hadGrantId: true }),
      }),
    );
    // NEVER log the grant value itself.
    const call = vi.mocked(createAuditLogAsync).mock.calls[0]?.[0] as { details?: Record<string, unknown> };
    expect(JSON.stringify(call?.details ?? {})).not.toContain('stale-grant');
  });

  it('audits hadGrantId: false when no grant was presented at all', async () => {
    epochsMock.getUserEpochs.mockResolvedValue({ authEpoch: 1, mfaEpoch: 1 });
    const res = await enforceApproverRegisterStepUp(ctx(), authCtx({ sid: 'sid-1' }), undefined, { consume: false });
    expect(res?.status).toBe(403);
    expect(createAuditLogAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({ hadGrantId: false }),
      }),
    );
  });

  it('503s when sid or epochs are missing', async () => {
    epochsMock.getUserEpochs.mockResolvedValue(null);
    const res = await enforceApproverRegisterStepUp(ctx(), authCtx({ sid: 'sid-1' }), 'g-1', { consume: false });
    expect(res?.status).toBe(503);
  });

  // A6 (previously untested branch): epochs present but the session has no
  // `sid` (e.g. a legacy token minted before sid binding existed).
  it('503s when epochs are present but auth.token.sid is missing', async () => {
    epochsMock.getUserEpochs.mockResolvedValue({ authEpoch: 1, mfaEpoch: 1 });
    const res = await enforceApproverRegisterStepUp(ctx(), authCtx(), 'g-1', { consume: false });
    expect(res?.status).toBe(503);
    expect(grantMocks.validateStepUpGrant).not.toHaveBeenCalled();
    expect(grantMocks.consumeStepUpGrant).not.toHaveBeenCalled();
  });

  it('validates without consuming at the options phase', async () => {
    epochsMock.getUserEpochs.mockResolvedValue({ authEpoch: 1, mfaEpoch: 2 });
    grantMocks.validateStepUpGrant.mockResolvedValue(true);
    const res = await enforceApproverRegisterStepUp(ctx(), authCtx({ sid: 'sid-1' }), 'g-1', { consume: false });
    expect(res).toBeNull();
    expect(grantMocks.validateStepUpGrant).toHaveBeenCalledWith('g-1', {
      userId: 'user-1',
      operation: 'register_approver_device',
      authEpoch: 1,
      mfaEpoch: 2,
      sid: 'sid-1',
    });
    expect(grantMocks.consumeStepUpGrant).not.toHaveBeenCalled();
  });

  it('consumes at the terminal phase', async () => {
    epochsMock.getUserEpochs.mockResolvedValue({ authEpoch: 1, mfaEpoch: 2 });
    grantMocks.consumeStepUpGrant.mockResolvedValue(true);
    const res = await enforceApproverRegisterStepUp(ctx(), authCtx({ sid: 'sid-1' }), 'g-1', { consume: true });
    expect(res).toBeNull();
    expect(grantMocks.consumeStepUpGrant).toHaveBeenCalledTimes(1);
  });
});

describe('userHasStrongerReauthFactor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.selectQueue = [];
    selectLimit.mockImplementation(() => Promise.resolve(dbState.selectQueue.shift() ?? []));
  });

  it.each([
    [{ mfaEnabled: true, mfaMethod: 'totp', passkeyCount: 0 }, true],
    [{ mfaEnabled: true, mfaMethod: 'sms', passkeyCount: 0 }, false], // SMS keeps password path
    [{ mfaEnabled: false, mfaMethod: null, passkeyCount: 1 }, true],
    [{ mfaEnabled: false, mfaMethod: null, passkeyCount: 0 }, false],
  ])('%o -> %s', async (row, expected) => {
    dbState.selectQueue.push([row]);
    await expect(userHasStrongerReauthFactor('user-1')).resolves.toBe(expected);
  });
});

// A8 (review finding): with 2FA disabled cluster-wide, POST /auth/mfa/step-up
// (the "stronger factor" gate's escape route) is dead, so the
// password-fallback mint must stay available even for accounts that still
// hold a TOTP secret or passkey row.
describe('userHasStrongerReauthFactor — ENABLE_2FA=false escape hatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.selectQueue = [];
    selectLimit.mockImplementation(() => Promise.resolve(dbState.selectQueue.shift() ?? []));
  });

  afterEach(() => {
    enable2faState.value = true;
  });

  it('returns false immediately without querying the DB when ENABLE_2FA=false, even for a TOTP-protected user', async () => {
    enable2faState.value = false;
    dbState.selectQueue.push([{ mfaEnabled: true, mfaMethod: 'totp', passkeyCount: 0 }]);

    await expect(userHasStrongerReauthFactor('user-1')).resolves.toBe(false);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('still evaluates the real factor state when ENABLE_2FA=true', async () => {
    enable2faState.value = true;
    dbState.selectQueue.push([{ mfaEnabled: true, mfaMethod: 'totp', passkeyCount: 0 }]);

    await expect(userHasStrongerReauthFactor('user-1')).resolves.toBe(true);
  });
});
