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
  grantMocks,
  epochsMock,
  authState,
} = vi.hoisted(() => {
  // Every `where(...)` expression handed to a select is recorded so tests can
  // assert on the predicate itself, not just on the rows the mock replays.
  // Required for the ownership guard on the mobile-device lookup: a test that
  // only inspects the inserted value would still pass with
  // `eq(mobileDevices.userId, ...)` deleted.
  const selectWheres: unknown[] = [];

  const makeSelectChain = (rows: unknown[]) => {
    const chain: any = {
      from: vi.fn(() => chain),
      leftJoin: vi.fn(() => chain),
      innerJoin: vi.fn(() => chain),
      where: vi.fn((expr: unknown) => {
        selectWheres.push(expr);
        return chain;
      }),
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
      selectWheres,
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
      verifyMobileSignature: vi.fn(),
    },
    helperMocks: {
      requireCurrentPasswordStepUp: vi.fn(),
      writeAuthAudit: vi.fn(),
      enforceApproverRegisterStepUp: vi.fn(),
      userHasStrongerReauthFactor: vi.fn(),
    },
    grantMocks: {
      mintStepUpGrant: vi.fn(),
    },
    epochsMock: {
      getUserEpochs: vi.fn(),
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

vi.mock('../services/mfaStepUpGrant', () => ({
  ...grantMocks,
}));

vi.mock('../services', () => ({
  getRedis: vi.fn(() => redisMock),
  getUserEpochs: epochsMock.getUserEpochs,
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
  mobileDevices: {
    id: 'mobileDevices.id',
    // NOTE: `deviceId` is the varchar external (per-install) id; `id` is the
    // server-side uuid PK. Keeping both stubs distinct is what lets the tests
    // below prove the lookup targets the varchar column.
    deviceId: 'mobileDevices.deviceId',
    userId: 'mobileDevices.userId',
    status: 'mobileDevices.status',
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
      token: { mfa: true, sid: 'sid-123' },
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

/**
 * Flattens a drizzle SQL expression (as produced by `and(eq(...), eq(...))`)
 * into the list of literal values it was built from. The suite's schema mock
 * hands drizzle plain strings as "columns", so both the column stubs and the
 * bound values land in the result — which is exactly what lets a test assert
 * that a specific predicate is present in a `where`.
 */
function sqlValues(expr: unknown): unknown[] {
  const out: unknown[] = [];
  const visit = (node: any): void => {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (typeof node === 'object') {
      if (Array.isArray(node.queryChunks)) {
        node.queryChunks.forEach(visit);
        return;
      }
      if ('value' in node) {
        visit(node.value);
        return;
      }
      return;
    }
    out.push(node);
  };
  visit(expr);
  return out;
}

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
    dbState.selectWheres.length = 0;
    dbState.updateSets = [];
    dbState.insertValues = [];
    dbState.insertReturning = [deviceRow];
    dbState.updateReturningQueue = [];
    authState.requireAuthorizationHeader = true;
    authState.denyPermission = false;
    helperMocks.requireCurrentPasswordStepUp.mockResolvedValue(null);
    helperMocks.writeAuthAudit.mockReturnValue(undefined);
    helperMocks.enforceApproverRegisterStepUp.mockResolvedValue(null);
    helperMocks.userHasStrongerReauthFactor.mockResolvedValue(false);
    epochsMock.getUserEpochs.mockResolvedValue({ authEpoch: 1, mfaEpoch: 1 });
    grantMocks.mintStepUpGrant.mockResolvedValue('grant-uuid');
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
    mobileHwKeyMocks.verifyMobileSignature.mockReturnValue(true);
    app = new Hono();
    app.route('/authenticator', authenticatorRoutes);
    app.route('/me/approver-devices', approverDevicesRoutes);
  });

  // Shared request-builder for the authenticator routes — mirrors the file's
  // existing app.request(...) style, defaulting to an authenticated caller.
  async function postJson(path: string, body: unknown, opts: { authorized?: boolean } = {}) {
    const authorized = opts.authorized ?? true;
    return app.request(`/authenticator${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authorized ? { Authorization: 'Bearer access-token' } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  it('requires authentication for registration options', async () => {
    const res = await postJson('/devices/webauthn/options', { registerGrantId: 'g-1' }, { authorized: false });
    expect(res.status).toBe(401);
    expect(approverMocks.generateApproverRegistrationOptions).not.toHaveBeenCalled();
  });

  it('returns registration options after grant validation (non-consuming)', async () => {
    const res = await postJson('/devices/webauthn/options', { registerGrantId: 'g-1' });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ options: { challenge: 'register-challenge' } });
    expect(helperMocks.enforceApproverRegisterStepUp).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'g-1',
      { consume: false },
    );
    expect(approverMocks.generateApproverRegistrationOptions).toHaveBeenCalledWith(
      expect.objectContaining({ user: expect.objectContaining({ id: 'user-123' }) }),
    );
  });

  it('blocks registration options when grant enforcement fails', async () => {
    helperMocks.enforceApproverRegisterStepUp.mockResolvedValueOnce(
      // a Response from the helper signals failure
      new Response(JSON.stringify({ error: 'register_step_up_required' }), { status: 403 }),
    );

    const res = await postJson('/devices/webauthn/options', { registerGrantId: 'bad-grant' });

    expect(res.status).toBe(403);
    expect(approverMocks.generateApproverRegistrationOptions).not.toHaveBeenCalled();
  });

  it('verifies registration and inserts a webauthn_platform device row', async () => {
    const res = await postJson('/devices/webauthn/verify', {
      registerGrantId: 'g-1',
      label: 'My Laptop',
      response: { id: 'credential-1', response: {} },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, device: { id: 'device-1' } });
    expect(helperMocks.enforceApproverRegisterStepUp).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'g-1',
      { consume: true },
    );

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

  // --- Mobile hardware-key registration (POST /devices) — register-grant required, activates on first signature ---

  it('registers a mobile_hw_key after grant consumption and stores it pending', async () => {
    dbState.insertReturning = [
      {
        ...deviceRow,
        id: 'mobile-pending-1',
        kind: 'mobile_hw_key',
        label: 'iPhone',
        credentialId: null,
        lastUsedAt: null,
        disabledAt: null,
      },
    ];

    const res = await postJson('/devices', {
      registerGrantId: 'g-mobile-1',
      kind: 'mobile_hw_key',
      publicKey: 'pk',
      label: 'iPhone',
      isPlatformBound: true,
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.device.id).toBe('mobile-pending-1');
    expect(body.device.label).toBe('iPhone');

    // Grant must be consumed before insert, matching the sibling's contract.
    expect(helperMocks.enforceApproverRegisterStepUp).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'g-mobile-1',
      { consume: true },
    );
    expect(helperMocks.requireCurrentPasswordStepUp).not.toHaveBeenCalled();

    const inserted = dbState.insertValues[0];
    expect(inserted).toMatchObject({
      userId: 'user-123',
      kind: 'mobile_hw_key',
      publicKey: 'pk',
      label: 'iPhone',
      credentialId: null,
      signCount: 0,
      isPlatformBound: true,
    });
    // Pending marker: never used yet — the insert must NOT set last_used_at; it
    // stays null until the first approval signature flips it active (server-side,
    // in the assurance path).
    expect(inserted).not.toHaveProperty('lastUsedAt');
    expect(mobileHwKeyMocks.verifyMobileSignature).not.toHaveBeenCalled();
    expect(helperMocks.writeAuthAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'auth.authenticator.device.register' }),
    );
  });

  it('rejects mobile_hw_key registration when grant enforcement fails, including a missing registerGrantId (403)', async () => {
    // registerGrantId is optional at the schema layer (mirrors the existing
    // stepUpGrantId fields) — a missing grant reaches the security helper and
    // gets the uniform 403, not a generic validation 400.
    helperMocks.enforceApproverRegisterStepUp.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'register_step_up_required' }), { status: 403 }),
    );
    const missingGrantRes = await postJson('/devices', {
      kind: 'mobile_hw_key',
      publicKey: 'pk',
      label: 'iPhone',
      isPlatformBound: true,
    });
    expect(missingGrantRes.status).toBe(403);
    expect(helperMocks.enforceApproverRegisterStepUp).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      undefined,
      { consume: true },
    );
    expect(dbState.insertValues).toHaveLength(0);
  });

  it('rejects mobile_hw_key registration when grant enforcement fails (403)', async () => {
    helperMocks.enforceApproverRegisterStepUp.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'register_step_up_required' }), { status: 403 }),
    );

    const res = await postJson('/devices', {
      registerGrantId: 'g-bad',
      kind: 'mobile_hw_key',
      publicKey: 'pk',
      label: 'iPhone',
      isPlatformBound: true,
    });

    expect(res.status).toBe(403);
    expect(helperMocks.enforceApproverRegisterStepUp).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'g-bad',
      { consume: true },
    );
    // No insert should happen when the grant is rejected.
    expect(dbState.insertValues).toHaveLength(0);
  });

  // --- X-Breeze-Mobile-Device-Id resolution (Sentry BREEZE-12 / BREEZE-13) ---
  //
  // The header carries `mobile_devices.device_id` (a varchar per-install id
  // minted on the phone), NOT `mobile_devices.id` (the uuid PK that
  // authenticator_devices.mobile_device_id FKs). Writing the header straight
  // into the FK column 500'd on every mobile registration (23503, or 22P02 for
  // a non-uuid header). The route must resolve it to an OWNED row instead.

  // Per-install id as the app actually mints it (SecureStore uuid) — uuid-SHAPED
  // but it is a device_id value, never a mobile_devices.id.
  const INSTALL_ID = '11111111-2222-3333-4444-555555555555';
  const OWNED_MOBILE_ROW_ID = '99999999-8888-7777-6666-555555555555';

  async function postMobileRegister(headerValue: string | null, grantId = 'g-mobile-2') {
    return app.request('/authenticator/devices', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer access-token',
        ...(headerValue === null ? {} : { 'X-Breeze-Mobile-Device-Id': headerValue }),
      },
      body: JSON.stringify({
        registerGrantId: grantId,
        kind: 'mobile_hw_key',
        publicKey: 'pk',
        label: 'iPhone',
        isPlatformBound: true,
      }),
    });
  }

  it('resolves the per-install header to the owned mobile_devices row id (never the raw header)', async () => {
    // The ownership-scoped lookup finds the caller's own row.
    dbState.selectQueue.push([{ id: OWNED_MOBILE_ROW_ID }]);
    dbState.insertReturning = [
      {
        ...deviceRow,
        id: 'mobile-pending-2',
        kind: 'mobile_hw_key',
        credentialId: null,
        lastUsedAt: null,
        mobileDeviceId: OWNED_MOBILE_ROW_ID,
      },
    ];

    const res = await postMobileRegister(INSTALL_ID);

    expect(res.status).toBe(201);
    const inserted = dbState.insertValues[0];
    expect(inserted).toMatchObject({ kind: 'mobile_hw_key', mobileDeviceId: OWNED_MOBILE_ROW_ID });
    // The raw header must never reach the FK column.
    expect(inserted?.mobileDeviceId).not.toBe(INSTALL_ID);
    // Audit records the RESOLVED id, and nothing unresolved to conflate with it.
    expect(helperMocks.writeAuthAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'auth.authenticator.device.register',
        details: expect.objectContaining({ mobileDeviceId: OWNED_MOBILE_ROW_ID }),
      }),
    );
    const auditDetails = (helperMocks.writeAuthAudit.mock.calls.at(-1)?.[1] as any).details;
    expect(auditDetails).not.toHaveProperty('mobileDeviceHeaderUnresolved');
  });

  it('looks the header up by device_id AND user_id — the ownership predicate is in the where', async () => {
    dbState.selectQueue.push([{ id: OWNED_MOBILE_ROW_ID }]);

    const res = await postMobileRegister(INSTALL_ID);
    expect(res.status).toBe(201);

    expect(dbState.selectWheres).toHaveLength(1);
    const values = sqlValues(dbState.selectWheres[0]);
    // Matched against the varchar external id — NOT the uuid PK (a uuid-column
    // comparison is what produced the 22P02 on junk headers).
    expect(values).toContain('mobileDevices.deviceId');
    expect(values).toContain(INSTALL_ID);
    expect(values).not.toContain('mobileDevices.id');
    // Ownership: RLS does NOT do this for us — mobile_devices' SELECT policy has
    // an `OR EXISTS` branch letting a same-tenant token read a colleague's row.
    expect(values).toContain('mobileDevices.userId');
    expect(values).toContain('user-123');
  });

  it('returns 201 with mobileDeviceId null when the header matches no mobile_devices row', async () => {
    dbState.selectQueue.push([]); // no row for this per-install id

    const res = await postMobileRegister(INSTALL_ID);

    expect(res.status).toBe(201);
    expect(dbState.insertValues[0]).toMatchObject({ kind: 'mobile_hw_key', mobileDeviceId: null });
    // Forensics: the unresolved header is kept under a DISTINCT key so it can
    // never again be mistaken for a resolved mobile_devices.id.
    expect(helperMocks.writeAuthAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        details: expect.objectContaining({
          mobileDeviceId: null,
          mobileDeviceHeaderUnresolved: INSTALL_ID,
        }),
      }),
    );
  });

  it('never inserts a mobile_devices row owned by a different user', async () => {
    const OTHER_USERS_ROW_ID = '00000000-dead-beef-0000-000000000001';
    // The ownership-scoped lookup returns nothing: the row exists, but it
    // belongs to someone else. (The predicate itself is asserted above — this
    // case proves the other user's id never leaks into the insert.)
    dbState.selectQueue.push([]);

    const res = await postMobileRegister(INSTALL_ID);

    expect(res.status).toBe(201);
    expect(dbState.insertValues[0]).toMatchObject({ mobileDeviceId: null });
    expect(JSON.stringify(dbState.insertValues)).not.toContain(OTHER_USERS_ROW_ID);
    // And the query that decided this was ownership-scoped.
    expect(sqlValues(dbState.selectWheres[0])).toContain('mobileDevices.userId');
  });

  it('degrades to null (no throw, no 500) for a junk non-uuid header', async () => {
    dbState.selectQueue.push([]);

    const res = await postMobileRegister('hello');

    expect(res.status).toBe(201);
    expect(dbState.insertValues[0]).toMatchObject({ mobileDeviceId: null });
    // 'hello' is compared against a varchar column, so it is a miss — not a
    // uuid cast error (22P02).
    expect(sqlValues(dbState.selectWheres[0])).toContain('hello');
  });

  it('inserts mobileDeviceId null and issues no lookup when the header is absent', async () => {
    const res = await postMobileRegister(null);

    expect(res.status).toBe(201);
    expect(dbState.insertValues[0]).toMatchObject({ mobileDeviceId: null });
    expect(dbState.selectWheres).toHaveLength(0);
  });

  it('requires authentication for mobile_hw_key registration', async () => {
    const res = await postJson('/devices', {
      registerGrantId: 'g-mobile-3',
      kind: 'mobile_hw_key',
      publicKey: 'pk',
      label: 'iPhone',
      isPlatformBound: true,
    }, { authorized: false });
    expect(res.status).toBe(401);
    expect(dbState.insertValues).toHaveLength(0);
  });

  it('rejects mobile_hw_key registration with a missing publicKey (400)', async () => {
    const res = await postJson('/devices', {
      registerGrantId: 'g-mobile-4',
      kind: 'mobile_hw_key',
      label: 'iPhone',
      isPlatformBound: true,
    });
    expect(res.status).toBe(400);
    expect(dbState.insertValues).toHaveLength(0);
  });

  // A3 (review finding): the payload must be schema-validated BEFORE the
  // single-use grant is consumed, so a malformed request never burns a
  // caller's valid grant. A valid grant is supplied here to isolate the
  // ordering — if consume-then-parse regresses, enforceApproverRegisterStepUp
  // would be called (and "consumed") even though the request 400s.
  it('a malformed publicKey with a valid grant 400s WITHOUT ever consuming the grant', async () => {
    helperMocks.enforceApproverRegisterStepUp.mockResolvedValue(null);

    const res = await postJson('/devices', {
      registerGrantId: 'g-mobile-5',
      publicKey: 12345, // not a string — fails mobileHwKeyRegisterSchema
      label: 'iPhone',
    });

    expect(res.status).toBe(400);
    expect(dbState.insertValues).toHaveLength(0);
    expect(helperMocks.enforceApproverRegisterStepUp).not.toHaveBeenCalled();
  });

  describe('POST /register-grant', () => {
    it('mints a grant after password step-up when no stronger factor exists', async () => {
      helperMocks.userHasStrongerReauthFactor.mockResolvedValue(false);
      helperMocks.requireCurrentPasswordStepUp.mockResolvedValue(null);
      epochsMock.getUserEpochs.mockResolvedValue({ authEpoch: 1, mfaEpoch: 2 });
      grantMocks.mintStepUpGrant.mockResolvedValue('grant-uuid');

      const res = await postJson('/register-grant', { currentPassword: 'hunter2!' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ registerGrantId: 'grant-uuid' });
      expect(grantMocks.mintStepUpGrant).toHaveBeenCalledWith(
        expect.objectContaining({ operation: 'register_approver_device' }),
      );
    });

    it('403 stronger_factor_required when the account has TOTP or a passkey', async () => {
      helperMocks.userHasStrongerReauthFactor.mockResolvedValue(true);
      const res = await postJson('/register-grant', { currentPassword: 'hunter2!' });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'stronger_factor_required' });
      expect(helperMocks.requireCurrentPasswordStepUp).not.toHaveBeenCalled();
      // A4: the deny must be audited (failure result, reason on the details).
      expect(helperMocks.writeAuthAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'auth.authenticator.register_grant.denied',
          result: 'failure',
          reason: 'stronger_factor_required',
        }),
      );
    });

    it('propagates password step-up failures (401/429/503)', async () => {
      helperMocks.userHasStrongerReauthFactor.mockResolvedValue(false);
      helperMocks.requireCurrentPasswordStepUp.mockImplementation(async (c: any) =>
        c.json({ error: 'Invalid credentials' }, 401),
      );
      const res = await postJson('/register-grant', { currentPassword: 'wrong' });
      expect(res.status).toBe(401);
    });

    it('503 when sid/epochs unavailable', async () => {
      helperMocks.userHasStrongerReauthFactor.mockResolvedValue(false);
      helperMocks.requireCurrentPasswordStepUp.mockResolvedValue(null);
      epochsMock.getUserEpochs.mockResolvedValue(null);
      const res = await postJson('/register-grant', { currentPassword: 'hunter2!' });
      expect(res.status).toBe(503);
      // A4: the mint-failure 503 must be audited too.
      expect(helperMocks.writeAuthAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'auth.authenticator.register_grant.mint_failed',
          result: 'failure',
          reason: 'epochs_unavailable',
        }),
      );
    });

    // A5 (previously untested): mintStepUpGrant itself resolving null (e.g.
    // Redis down) — distinct from the epochs/sid-unavailable 503 above — must
    // also 503 and be audited.
    it('503 when mintStepUpGrant resolves null even though epochs/sid are present', async () => {
      helperMocks.userHasStrongerReauthFactor.mockResolvedValue(false);
      helperMocks.requireCurrentPasswordStepUp.mockResolvedValue(null);
      epochsMock.getUserEpochs.mockResolvedValue({ authEpoch: 1, mfaEpoch: 2 });
      grantMocks.mintStepUpGrant.mockResolvedValue(null);

      const res = await postJson('/register-grant', { currentPassword: 'hunter2!' });

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'Service temporarily unavailable' });
      expect(helperMocks.writeAuthAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'auth.authenticator.register_grant.mint_failed',
          result: 'failure',
          reason: 'mint_failed',
        }),
      );
    });
  });

  describe('register routes take registerGrantId', () => {
    it('options validates (consume:false); verify consumes (consume:true)', async () => {
      helperMocks.enforceApproverRegisterStepUp.mockResolvedValue(null);
      approverMocks.generateApproverRegistrationOptions.mockResolvedValue({ challenge: 'c' });
      await postJson('/devices/webauthn/options', { registerGrantId: 'g-1' });
      expect(helperMocks.enforceApproverRegisterStepUp).toHaveBeenLastCalledWith(
        expect.anything(), expect.anything(), 'g-1', { consume: false },
      );

      approverMocks.verifyApproverRegistration.mockResolvedValue({
        publicKey: 'pk', credentialId: 'cid', counter: 0, aaguid: null, transports: null, isPlatformBound: true,
      });
      dbState.insertReturning = [{ id: 'dev-1', label: 'x', kind: 'webauthn_platform', isPlatformBound: true, transports: [] }];
      await postJson('/devices/webauthn/verify', { registerGrantId: 'g-1', response: { id: 'att' } });
      expect(helperMocks.enforceApproverRegisterStepUp).toHaveBeenLastCalledWith(
        expect.anything(), expect.anything(), 'g-1', { consume: true },
      );
    });

    it('mobile POST /devices consumes the grant and no longer reads currentPassword', async () => {
      helperMocks.enforceApproverRegisterStepUp.mockResolvedValue(null);
      dbState.insertReturning = [{ id: 'dev-2', label: 'This device', kind: 'mobile_hw_key', isPlatformBound: true, transports: [] }];
      const res = await postJson('/devices', { registerGrantId: 'g-2', publicKey: 'SPKI', label: 'This device' });
      // The mobile route returns 201 on insert (unchanged by #2707 — only the
      // step-up mechanism moved from currentPassword to a register grant).
      expect(res.status).toBe(201);
      expect(helperMocks.enforceApproverRegisterStepUp).toHaveBeenLastCalledWith(
        expect.anything(), expect.anything(), 'g-2', { consume: true },
      );
      expect(helperMocks.requireCurrentPasswordStepUp).not.toHaveBeenCalled();
    });

    it('403s all three routes when enforcement rejects — including a missing grant', async () => {
      helperMocks.enforceApproverRegisterStepUp.mockImplementation(async (c: any) =>
        c.json({ error: 'register_step_up_required' }, 403),
      );
      for (const [path, body] of [
        ['/devices/webauthn/options', {}],
        ['/devices/webauthn/verify', { response: { id: 'att' } }],
        ['/devices', { publicKey: 'SPKI', label: 'x' }],
      ] as const) {
        const res = await postJson(path, body);
        expect(res.status, path).toBe(403);
      }
    });
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
