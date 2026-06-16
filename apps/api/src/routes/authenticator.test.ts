import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { authenticatorRoutes, approverDevicesRoutes } from './authenticator';
import { loadPartnerPolicy } from '../services/authenticatorPolicy';

const mockLoadPolicy = loadPartnerPolicy as unknown as ReturnType<typeof vi.fn>;

const {
  dbState,
  redisMock,
  approverMocks,
  mobileHwKeyMocks,
  helperMocks,
  authState,
} = vi.hoisted(() => {
  const makeSelectChain = (rows: unknown[]) => {
    const chain: any = {
      from: vi.fn(() => chain),
      leftJoin: vi.fn(() => chain),
      innerJoin: vi.fn(() => chain),
      where: vi.fn(() => chain),
      orderBy: vi.fn(() => chain),
      limit: vi.fn(() => Promise.resolve(rows)),
    };
    // Allow `await db.select()...where(...)` without `.limit()` too (list path).
    chain.then = (resolve: (v: unknown) => unknown) => resolve(rows);
    return chain;
  };

  return {
    dbState: {
      selectQueue: [] as unknown[][],
      updateSets: [] as Record<string, unknown>[],
      insertValues: [] as Record<string, unknown>[],
      insertReturning: [] as unknown[],
      updateReturningQueue: [] as unknown[][],
      makeSelectChain,
    },
    redisMock: {
      setex: vi.fn(),
      get: vi.fn(),
      del: vi.fn(),
      getdel: vi.fn(),
    },
    approverMocks: {
      generateApproverRegistrationOptions: vi.fn(),
      verifyApproverRegistration: vi.fn(),
    },
    mobileHwKeyMocks: {
      issueMobileRegistrationNonce: vi.fn(),
      consumeMobileRegistrationNonce: vi.fn(),
      verifyMobileSignature: vi.fn(),
    },
    helperMocks: {
      requireCurrentPasswordStepUp: vi.fn(),
      writeAuthAudit: vi.fn(),
    },
    authState: {
      requireAuthorizationHeader: true,
      denyPermission: false,
    },
  };
});

vi.mock('../services/approverWebAuthn', () => ({
  ...approverMocks,
}));

vi.mock('../services/mobileHwKey', () => ({
  ...mobileHwKeyMocks,
}));

vi.mock('./auth/helpers', () => ({
  ...helperMocks,
}));

vi.mock('../services', () => ({
  getRedis: vi.fn(() => redisMock),
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => dbState.makeSelectChain(dbState.selectQueue.shift() ?? [])),
    insert: vi.fn(() => ({
      values: vi.fn((values: Record<string, unknown>) => {
        dbState.insertValues.push(values);
        return {
          returning: vi.fn(() => Promise.resolve(dbState.insertReturning)),
          onConflictDoUpdate: vi.fn(() => Promise.resolve(undefined)),
        };
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        dbState.updateSets.push(values);
        const whereResult: any = Promise.resolve(undefined);
        whereResult.returning = vi.fn(() =>
          Promise.resolve(dbState.updateReturningQueue.shift() ?? [])
        );
        return {
          where: vi.fn(() => whereResult),
        };
      }),
    })),
  },
}));

vi.mock('../db/schema', () => ({
  authenticatorDevices: {
    id: 'authenticatorDevices.id',
    userId: 'authenticatorDevices.userId',
    kind: 'authenticatorDevices.kind',
    label: 'authenticatorDevices.label',
    publicKey: 'authenticatorDevices.publicKey',
    credentialId: 'authenticatorDevices.credentialId',
    signCount: 'authenticatorDevices.signCount',
    aaguid: 'authenticatorDevices.aaguid',
    transports: 'authenticatorDevices.transports',
    isPlatformBound: 'authenticatorDevices.isPlatformBound',
    mobileDeviceId: 'authenticatorDevices.mobileDeviceId',
    createdAt: 'authenticatorDevices.createdAt',
    lastUsedAt: 'authenticatorDevices.lastUsedAt',
    disabledAt: 'authenticatorDevices.disabledAt',
    disabledReason: 'authenticatorDevices.disabledReason',
  },
  authenticatorPolicies: {
    partnerId: 'authenticatorPolicies.partnerId',
  },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    if (authState.requireAuthorizationHeader && !c.req.header('authorization')) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      orgId: 'org-123',
      partnerId: 'partner-123',
      token: { mfa: true },
    });
    return next();
  }),
  // Permission gate — allow by default; toggle authState.denyPermission to 403.
  requirePermission: vi.fn(() => (c: any, next: any) =>
    authState.denyPermission ? c.json({ error: 'Forbidden' }, 403) : next(),
  ),
  requireMfa: vi.fn(() => (_c: any, next: any) => next()),
}));

vi.mock('../services/permissions', () => ({
  PERMISSIONS: {
    USERS_READ: { resource: 'users', action: 'read' },
    USERS_WRITE: { resource: 'users', action: 'write' },
  },
}));

vi.mock('../services/authenticatorPolicy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/authenticatorPolicy')>();
  return { ...actual, loadPartnerPolicy: vi.fn().mockResolvedValue(null) }; // validateRaiseOnly stays real
});

const deviceRow = {
  id: 'device-1',
  userId: 'user-123',
  kind: 'webauthn_platform',
  label: 'My Laptop',
  publicKey: 'public-key',
  credentialId: 'credential-1',
  signCount: 0,
  aaguid: null,
  transports: ['internal'],
  isPlatformBound: true,
  mobileDeviceId: null,
  createdAt: new Date('2026-06-14T00:00:00.000Z'),
  lastUsedAt: null,
  disabledAt: null,
  disabledReason: null,
};

describe('approver device routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    dbState.selectQueue = [];
    dbState.updateSets = [];
    dbState.insertValues = [];
    dbState.insertReturning = [deviceRow];
    dbState.updateReturningQueue = [];
    authState.requireAuthorizationHeader = true;
    authState.denyPermission = false;
    helperMocks.requireCurrentPasswordStepUp.mockResolvedValue(null);
    helperMocks.writeAuthAudit.mockReturnValue(undefined);
    approverMocks.generateApproverRegistrationOptions.mockResolvedValue({
      challenge: 'register-challenge',
      rp: { name: 'Breeze' },
    });
    approverMocks.verifyApproverRegistration.mockResolvedValue({
      credentialId: 'credential-1',
      publicKey: 'public-key',
      counter: 0,
      deviceType: 'singleDevice',
      backedUp: false,
      transports: ['internal'],
      aaguid: null,
      isPlatformBound: true,
    });
    mobileHwKeyMocks.issueMobileRegistrationNonce.mockResolvedValue('reg-nonce-abc');
    mobileHwKeyMocks.consumeMobileRegistrationNonce.mockResolvedValue('reg-nonce-abc');
    mobileHwKeyMocks.verifyMobileSignature.mockReturnValue(true);
    app = new Hono();
    app.route('/authenticator', authenticatorRoutes);
    app.route('/me/approver-devices', approverDevicesRoutes);
  });

  it('requires authentication for registration options', async () => {
    const res = await app.request('/authenticator/devices/webauthn/options', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'pw' }),
    });
    expect(res.status).toBe(401);
    expect(approverMocks.generateApproverRegistrationOptions).not.toHaveBeenCalled();
  });

  it('returns registration options after the current-password step-up', async () => {
    const res = await app.request('/authenticator/devices/webauthn/options', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer access-token' },
      body: JSON.stringify({ currentPassword: 'correct-password' }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ options: { challenge: 'register-challenge' } });
    expect(helperMocks.requireCurrentPasswordStepUp).toHaveBeenCalledWith(
      expect.anything(),
      'user-123',
      'correct-password',
      expect.any(String),
    );
    expect(approverMocks.generateApproverRegistrationOptions).toHaveBeenCalledWith(
      expect.objectContaining({ user: expect.objectContaining({ id: 'user-123' }) }),
    );
  });

  it('blocks registration options when the password step-up fails', async () => {
    helperMocks.requireCurrentPasswordStepUp.mockResolvedValueOnce(
      // a Response from the helper signals failure
      new Response(JSON.stringify({ error: 'Invalid credentials' }), { status: 401 }),
    );

    const res = await app.request('/authenticator/devices/webauthn/options', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer access-token' },
      body: JSON.stringify({ currentPassword: 'wrong-password' }),
    });

    expect(res.status).toBe(401);
    expect(approverMocks.generateApproverRegistrationOptions).not.toHaveBeenCalled();
  });

  it('verifies registration and inserts a webauthn_platform device row', async () => {
    const res = await app.request('/authenticator/devices/webauthn/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer access-token' },
      body: JSON.stringify({ label: 'My Laptop', response: { id: 'credential-1', response: {} } }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, device: { id: 'device-1' } });

    const inserted = dbState.insertValues[0];
    expect(inserted).toMatchObject({
      userId: 'user-123',
      kind: 'webauthn_platform',
      publicKey: 'public-key',
      credentialId: 'credential-1',
      signCount: 0,
      isPlatformBound: true,
      label: 'My Laptop',
    });
    expect(helperMocks.writeAuthAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'auth.authenticator.device.register' }),
    );
  });

  it('lists only the caller active approver devices', async () => {
    dbState.selectQueue.push([deviceRow]);

    const res = await app.request('/me/approver-devices', {
      method: 'GET',
      headers: { Authorization: 'Bearer access-token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.devices).toHaveLength(1);
    expect(body.devices[0]).toMatchObject({ id: 'device-1', label: 'My Laptop', isPlatformBound: true });
  });

  it('revokes a device by setting disabledAt', async () => {
    dbState.selectQueue.push([deviceRow]);

    const res = await app.request('/me/approver-devices/device-1/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer access-token' },
      body: JSON.stringify({ reason: 'lost device' }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true });
    const set = dbState.updateSets.find((s) => 'disabledAt' in s);
    expect(set).toBeDefined();
    expect(set?.disabledAt).toBeInstanceOf(Date);
    expect(set).toMatchObject({ disabledReason: 'lost device' });
  });

  it('returns 404 revoking a device the user does not own', async () => {
    dbState.selectQueue.push([]);

    const res = await app.request('/me/approver-devices/device-1/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer access-token' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(404);
    expect(dbState.updateSets).toHaveLength(0);
  });

  it('renames an approver device label', async () => {
    dbState.selectQueue.push([deviceRow]);
    dbState.updateReturningQueue.push([{ ...deviceRow, label: 'New Name' }]);

    const res = await app.request('/me/approver-devices/device-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer access-token' },
      body: JSON.stringify({ label: 'New Name' }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, device: { label: 'New Name' } });
    expect(dbState.updateSets).toContainEqual(expect.objectContaining({ label: 'New Name' }));
  });

  it('requires authentication for mobile-hw-key registration options', async () => {
    const res = await app.request('/authenticator/devices/mobile-hw-key/options', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'pw' }),
    });
    expect(res.status).toBe(401);
    expect(mobileHwKeyMocks.issueMobileRegistrationNonce).not.toHaveBeenCalled();
  });

  it('returns a registration nonce after the current-password step-up', async () => {
    const res = await app.request('/authenticator/devices/mobile-hw-key/options', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer access-token' },
      body: JSON.stringify({ currentPassword: 'correct-password' }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ nonce: 'reg-nonce-abc' });
    expect(helperMocks.requireCurrentPasswordStepUp).toHaveBeenCalledWith(
      expect.anything(),
      'user-123',
      'correct-password',
      expect.any(String),
    );
    expect(mobileHwKeyMocks.issueMobileRegistrationNonce).toHaveBeenCalledWith('user-123');
  });

  it('blocks mobile-hw-key options when the password step-up fails', async () => {
    helperMocks.requireCurrentPasswordStepUp.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Invalid credentials' }), { status: 401 }),
    );

    const res = await app.request('/authenticator/devices/mobile-hw-key/options', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer access-token' },
      body: JSON.stringify({ currentPassword: 'wrong-password' }),
    });

    expect(res.status).toBe(401);
    expect(mobileHwKeyMocks.issueMobileRegistrationNonce).not.toHaveBeenCalled();
  });

  it('verifies the PoP signature and inserts a mobile_hw_key device row', async () => {
    dbState.insertReturning = [
      { ...deviceRow, id: 'mobile-device-1', kind: 'mobile_hw_key', credentialId: null, mobileDeviceId: '11111111-2222-3333-4444-555555555555' },
    ];

    const res = await app.request('/authenticator/devices/mobile-hw-key/verify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer access-token',
        'X-Breeze-Mobile-Device-Id': '11111111-2222-3333-4444-555555555555',
      },
      body: JSON.stringify({ publicKey: 'spki-base64', signature: 'sig-base64', label: 'My iPhone' }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, device: { id: 'mobile-device-1', kind: 'mobile_hw_key' } });

    // Nonce is consumed (single-use) and the signature is verified over it.
    expect(mobileHwKeyMocks.consumeMobileRegistrationNonce).toHaveBeenCalledWith('user-123');
    expect(mobileHwKeyMocks.verifyMobileSignature).toHaveBeenCalledWith({
      publicKeySpkiB64: 'spki-base64',
      payload: 'reg-nonce-abc',
      signatureB64: 'sig-base64',
    });

    const inserted = dbState.insertValues[0];
    expect(inserted).toMatchObject({
      userId: 'user-123',
      kind: 'mobile_hw_key',
      publicKey: 'spki-base64',
      credentialId: null,
      signCount: 0,
      isPlatformBound: true,
      label: 'My iPhone',
      mobileDeviceId: '11111111-2222-3333-4444-555555555555',
    });
    expect(helperMocks.writeAuthAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'auth.authenticator.device.register' }),
    );
  });

  it('rejects a bad PoP signature with 400 and does not insert', async () => {
    mobileHwKeyMocks.verifyMobileSignature.mockReturnValueOnce(false);

    const res = await app.request('/authenticator/devices/mobile-hw-key/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer access-token' },
      body: JSON.stringify({ publicKey: 'spki-base64', signature: 'bad-sig', label: 'My iPhone' }),
    });

    expect(res.status).toBe(400);
    expect(dbState.insertValues).toHaveLength(0);
    expect(helperMocks.writeAuthAudit).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'auth.authenticator.device.register' }),
    );
  });

  it('rejects mobile-hw-key verify with 400 when the registration nonce is missing/expired', async () => {
    mobileHwKeyMocks.consumeMobileRegistrationNonce.mockResolvedValueOnce(null);

    const res = await app.request('/authenticator/devices/mobile-hw-key/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer access-token' },
      body: JSON.stringify({ publicKey: 'spki-base64', signature: 'sig-base64', label: 'My iPhone' }),
    });

    expect(res.status).toBe(400);
    expect(mobileHwKeyMocks.verifyMobileSignature).not.toHaveBeenCalled();
    expect(dbState.insertValues).toHaveLength(0);
  });

  it('inserts mobile_hw_key with mobileDeviceId null when the header is absent', async () => {
    dbState.insertReturning = [
      { ...deviceRow, id: 'mobile-device-2', kind: 'mobile_hw_key', credentialId: null },
    ];

    const res = await app.request('/authenticator/devices/mobile-hw-key/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer access-token' },
      body: JSON.stringify({ publicKey: 'spki-base64', signature: 'sig-base64' }),
    });

    expect(res.status).toBe(200);
    const inserted = dbState.insertValues[0];
    expect(inserted).toMatchObject({ kind: 'mobile_hw_key', mobileDeviceId: null });
  });
});

describe('approval-security policy routes (Phase 4)', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    dbState.selectQueue = [];
    dbState.insertValues = [];
    authState.requireAuthorizationHeader = false;
    authState.denyPermission = false;
    mockLoadPolicy.mockResolvedValue(null);
    helperMocks.writeAuthAudit.mockReturnValue(undefined);
    app = new Hono();
    app.route('/authenticator', authenticatorRoutes);
  });

  it('GET /policy returns the Breeze defaults when no policy is set', async () => {
    const res = await app.request('/authenticator/policy');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      policy: { floorOverrides: {}, requireEnrollment: false, enforceFrom: null },
    });
  });

  it('GET /policy returns the stored policy', async () => {
    mockLoadPolicy.mockResolvedValue({
      floorOverrides: { high: 4 },
      requireEnrollment: true,
      enforceFrom: new Date('2026-07-01T00:00:00.000Z'),
    });
    const res = await app.request('/authenticator/policy');
    expect(await res.json()).toEqual({
      policy: { floorOverrides: { high: 4 }, requireEnrollment: true, enforceFrom: '2026-07-01T00:00:00.000Z' },
    });
  });

  it('PUT /policy upserts a raise-only policy and audits it', async () => {
    const res = await app.request('/authenticator/policy', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ floorOverrides: { medium: 3 }, requireEnrollment: true, enforceFrom: null }),
    });
    expect(res.status).toBe(200);
    expect(dbState.insertValues[0]).toMatchObject({
      partnerId: 'partner-123',
      requireEnrollment: true,
      floorOverrides: { medium: 3 },
    });
    expect(helperMocks.writeAuthAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'auth.authenticator.policy.update' }),
    );
  });

  it('PUT /policy rejects a weakening (raise-only violation) with 400', async () => {
    const res = await app.request('/authenticator/policy', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ floorOverrides: { critical: 2 }, requireEnrollment: true, enforceFrom: null }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_policy');
    expect(dbState.insertValues).toHaveLength(0);
  });

  it('PUT /policy is gated by the write permission (403 when denied)', async () => {
    authState.denyPermission = true;
    const res = await app.request('/authenticator/policy', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ floorOverrides: {}, requireEnrollment: true, enforceFrom: null }),
    });
    expect(res.status).toBe(403);
  });
});
