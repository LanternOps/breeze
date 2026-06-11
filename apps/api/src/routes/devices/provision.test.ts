import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// ---------- hoisted mocks (vi.mock factories run BEFORE imports) ----------
const { authMiddlewareMock, requireScopeMock, requirePermissionMock, requireMfaMock } = vi.hoisted(() => ({
  authMiddlewareMock: vi.fn(),
  requireScopeMock: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermissionMock: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfaMock: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(),
    transaction: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: authMiddlewareMock,
  requireScope: requireScopeMock,
  requirePermission: requirePermissionMock,
  requireMfa: requireMfaMock,
}));

vi.mock('./helpers', () => ({
  stripSensitiveDeviceFields: (d: any) => d,
}));

vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

vi.mock('../../services/permissions', () => ({
  PERMISSIONS: { DEVICES_WRITE: { resource: 'devices', action: 'write' } },
  // Faithful re-implementation: unrestricted (no allowedSiteIds) always passes;
  // otherwise the siteId must be in the allowlist.
  canAccessSite: (perms: any, siteId: string) =>
    !perms?.allowedSiteIds || perms.allowedSiteIds.includes(siteId),
}));

vi.mock('../agents/helpers', () => ({
  generateAgentId: vi.fn(() => 'agent-prov-1'),
  generateApiKey: vi.fn(() => 'brz_prov_token'),
  issueMtlsCertForDevice: vi.fn(async () => null),
}));

vi.mock('../../services/manifestSigning', () => ({
  getActiveTrustKeyset: vi.fn(async () => []),
}));

vi.mock('../../db/schema', () => ({
  devices: {
    id: 'id', hostname: 'hostname', orgId: 'orgId', siteId: 'siteId', status: 'status', agentId: 'agentId',
  },
  organizations: { id: 'id', partnerId: 'partnerId' },
  sites: { id: 'id', orgId: 'orgId' },
  partners: { id: 'id', maxDevices: 'maxDevices' },
  provisionCredentialHandles: {
    id: 'id', token: 'token', orgId: 'orgId', deviceId: 'deviceId',
    credentials: 'credentials', consumedAt: 'consumedAt', expiresAt: 'expiresAt',
  },
}));

vi.mock('../../services/provisionCredentialHandle', () => ({
  PROVISION_HANDLE_TOKEN_PATTERN: /^[a-f0-9]{64}$/,
  generateProvisionHandleToken: vi.fn(() => 'a'.repeat(64)),
  provisionHandleExpiresAt: vi.fn(() => new Date('2030-01-01T00:00:00.000Z')),
}));

import { db } from '../../db';
import { writeRouteAudit } from '../../services/auditEvents';
import { provisionRoutes } from './provision';

// Snapshot middleware registration calls before clearAllMocks wipes them
const registeredScopeCalls: string[][] = (requireScopeMock.mock.calls as unknown as unknown[][]).map(
  (c) => c.flat().map((v) => String(v)),
);
const registeredPermResources: string[] = (requirePermissionMock.mock.calls as unknown as unknown[][]).map(
  (c) => c.map((v) => String(v)).join(':'),
);
const registeredMfaCallCount = requireMfaMock.mock.calls.length;

const ORG_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SITE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER_ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const BASE_BODY = {
  orgId: ORG_ID,
  siteId: SITE_ID,
  hostname: 'provisioned-host-1',
  osType: 'windows',
};

function setAuth(
  overrides: Partial<{
    canAccessOrg: (id: string) => boolean;
    allowedSiteIds: string[];
  }> = {},
) {
  authMiddlewareMock.mockImplementation((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-1', email: 'a@example.com' },
      canAccessOrg: overrides.canAccessOrg ?? ((id: string) => id === ORG_ID),
    });
    // Mirror authMiddleware: populate the per-request permissions object. A
    // site-restricted user has `allowedSiteIds`; unrestricted users do not.
    c.set(
      'permissions',
      overrides.allowedSiteIds !== undefined
        ? { allowedSiteIds: overrides.allowedSiteIds }
        : {},
    );
    return next();
  });
}

function mockSelectRows(rows: any[]) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn().mockResolvedValue(rows),
      })),
    })),
  } as any);
}

function mockTransactionSuccess(insertedRow: any) {
  vi.mocked(db.transaction).mockImplementation(async (cb: any) => {
    const tx = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: ORG_ID, partnerId: null }]),
          }),
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([insertedRow]),
        }),
      }),
    };
    return cb(tx);
  });
}

/** Mocks `db.insert(...).values(...)` resolving successfully (handle persist). */
function mockInsertSuccess() {
  vi.mocked(db.insert).mockReturnValue({
    values: vi.fn().mockResolvedValue(undefined),
  } as any);
}

/** Mocks the fetch-endpoint's `db.select(...).from().where().limit()` lookup. */
function mockHandleSelect(rows: any[]) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn().mockResolvedValue(rows),
      })),
    })),
  } as any);
}

/** Mocks the atomic `db.update(...).set().where().returning()` consume. */
function mockHandleConsume(rows: any[]) {
  vi.mocked(db.update).mockReturnValue({
    set: vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn().mockResolvedValue(rows),
      })),
    })),
  } as any);
}

/** Mocks `db.delete(...).where()` (chainable, catch-able). */
function mockHandleDelete() {
  const chain: any = {
    where: vi.fn(() => chain),
    catch: vi.fn((cb: any) => Promise.resolve().catch(cb)),
    then: (resolve: any) => Promise.resolve().then(resolve),
  };
  vi.mocked(db.delete).mockReturnValue(chain);
}

describe('POST /devices/provision', () => {
  let app: Hono;

  beforeAll(() => {
    process.env.PUBLIC_API_URL = 'https://breeze.example.com';
  });

  beforeEach(() => {
    vi.clearAllMocks();
    setAuth();
    app = new Hono();
    app.route('/devices', provisionRoutes);
  });

  describe('route registration', () => {
    it('mounts with the expected middleware gates (scope/perm/MFA)', () => {
      expect(
        registeredScopeCalls.some((a) => a.includes('organization') && a.includes('partner') && a.includes('system')),
      ).toBe(true);
      expect(registeredPermResources).toContain('devices:write');
      expect(registeredMfaCallCount).toBeGreaterThan(0);
    });
  });

  describe('happy path', () => {
    it('creates a device and returns a one-time fetch URL (no inline secrets)', async () => {
      mockSelectRows([{ id: SITE_ID }]);     // site-in-org check
      mockSelectRows([]);                     // hostname collision check (none)
      mockTransactionSuccess({
        id: 'device-prov-id',
        orgId: ORG_ID,
        siteId: SITE_ID,
        hostname: BASE_BODY.hostname,
        agentId: 'agent-prov-1',
        status: 'pending',
      });
      mockInsertSuccess();                    // credential-handle persist

      const res = await app.request('/devices/provision', {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify(BASE_BODY),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.device.id).toBe('device-prov-id');

      // SECURITY (#917 L-3): secrets must NOT be inline in the provision body.
      expect(body.config).toBeUndefined();
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain('brz_prov_token');     // auth/watchdog/helper tokens
      expect(serialized).not.toContain('private_key');

      // Instead, a short-TTL single-use fetch handle is returned.
      expect(body.credentials).toMatchObject({
        fetch_url: '/api/v1/devices/provision/fetch/' + 'a'.repeat(64),
        fetch_token: 'a'.repeat(64),
        single_use: true,
      });
      expect(body.credentials.expires_at).toBe('2030-01-01T00:00:00.000Z');

      // The blob WAS persisted server-side (keyed by the handle).
      expect(db.insert).toHaveBeenCalled();

      // Audit was written on success
      expect(writeRouteAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'device.provision',
          resourceId: 'device-prov-id',
          orgId: ORG_ID,
        }),
      );
    });

    it('passes through all 3 supported osType values', async () => {
      for (const os of ['windows', 'macos', 'linux'] as const) {
        vi.clearAllMocks();
        setAuth();
        mockSelectRows([{ id: SITE_ID }]);
        mockSelectRows([]);
        mockTransactionSuccess({
          id: `device-${os}`,
          orgId: ORG_ID,
          siteId: SITE_ID,
          hostname: `host-${os}`,
          agentId: 'agent-prov-1',
          status: 'pending',
        });
        mockInsertSuccess();

        const res = await app.request('/devices/provision', {
          method: 'POST',
          headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...BASE_BODY, osType: os, hostname: `host-${os}` }),
        });
        expect(res.status).toBe(201);
      }
    });
  });

  describe('rejection paths', () => {
    it('returns 403 when caller cannot access the target org', async () => {
      setAuth({ canAccessOrg: () => false });
      const res = await app.request('/devices/provision', {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify(BASE_BODY),
      });
      expect(res.status).toBe(403);
      expect(db.select).not.toHaveBeenCalled();
    });

    it('returns 400 when the target site does not belong to the target org', async () => {
      mockSelectRows([]); // site-in-org check fails

      const res = await app.request('/devices/provision', {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify(BASE_BODY),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('site');
    });

    it('returns 500 when PUBLIC_API_URL and API_URL are both unset', async () => {
      const originalPublic = process.env.PUBLIC_API_URL;
      const originalApi = process.env.API_URL;
      delete process.env.PUBLIC_API_URL;
      delete process.env.API_URL;
      try {
        mockSelectRows([{ id: SITE_ID }]);
        const res = await app.request('/devices/provision', {
          method: 'POST',
          headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
          body: JSON.stringify(BASE_BODY),
        });
        expect(res.status).toBe(500);
        const body = await res.json();
        expect(body.error).toContain('Server URL not configured');
      } finally {
        process.env.PUBLIC_API_URL = originalPublic;
        if (originalApi) process.env.API_URL = originalApi;
      }
    });

    it('returns 409 on hostname collision (hard-fail, no auto-allow on decommissioned)', async () => {
      mockSelectRows([{ id: SITE_ID }]);
      // Existing decommissioned device with the same hostname
      mockSelectRows([{ id: 'existing-device', status: 'decommissioned' }]);

      const res = await app.request('/devices/provision', {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify(BASE_BODY),
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.reason).toBe('hostname_collision');

      // Audit fired with 'denied' for the hostname collision
      expect(writeRouteAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'device.provision',
          result: 'denied',
          details: expect.objectContaining({ reason: 'hostname_collision' }),
        }),
      );
      // Transaction never started
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('returns 400 on Zod validation failure (missing required field)', async () => {
      const res = await app.request('/devices/provision', {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId: ORG_ID }),
      });
      expect(res.status).toBe(400);
    });

    it('returns 400 on invalid osType', async () => {
      const res = await app.request('/devices/provision', {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...BASE_BODY, osType: 'bsd' }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('site-scope authorization (app-layer only; RLS does not defend it)', () => {
    it('returns 403 when a site-restricted caller provisions into an out-of-scope site', async () => {
      // Caller is restricted to a DIFFERENT site than the target.
      setAuth({ allowedSiteIds: ['some-other-site-id'] });
      mockSelectRows([{ id: SITE_ID }]); // site-in-org check passes (site does belong to org)

      const res = await app.request('/devices/provision', {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify(BASE_BODY),
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toContain('site');
      // Must reject BEFORE inserting the device.
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('succeeds when a site-restricted caller provisions into an in-scope site', async () => {
      setAuth({ allowedSiteIds: [SITE_ID] });
      mockSelectRows([{ id: SITE_ID }]); // site-in-org check
      mockSelectRows([]);                 // hostname collision (none)
      mockTransactionSuccess({
        id: 'device-in-scope',
        orgId: ORG_ID,
        siteId: SITE_ID,
        hostname: BASE_BODY.hostname,
        agentId: 'agent-prov-1',
        status: 'pending',
      });
      mockInsertSuccess();

      const res = await app.request('/devices/provision', {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify(BASE_BODY),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.device.id).toBe('device-in-scope');
    });

    it('is unchanged for unrestricted callers (no allowedSiteIds)', async () => {
      setAuth(); // no allowedSiteIds → unrestricted
      mockSelectRows([{ id: SITE_ID }]);
      mockSelectRows([]);
      mockTransactionSuccess({
        id: 'device-unrestricted',
        orgId: ORG_ID,
        siteId: SITE_ID,
        hostname: BASE_BODY.hostname,
        agentId: 'agent-prov-1',
        status: 'pending',
      });
      mockInsertSuccess();

      const res = await app.request('/devices/provision', {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify(BASE_BODY),
      });

      expect(res.status).toBe(201);
      expect(db.transaction).toHaveBeenCalled();
    });
  });

  describe('GET /devices/provision/fetch/:token (one-time credential fetch)', () => {
    const TOKEN = 'a'.repeat(64);
    const CONFIG = {
      agent_id: 'agent-prov-1',
      auth_token: 'brz_prov_token',
      mtls: { private_key: 'SECRET-KEY' },
    };

    function fetchReq(token = TOKEN) {
      return app.request(`/devices/provision/fetch/${token}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer t' },
      });
    }

    it('returns the credential blob exactly once, then deletes the handle', async () => {
      mockHandleSelect([
        {
          id: 'handle-1',
          orgId: ORG_ID,
          deviceId: 'device-prov-id',
          credentials: CONFIG,
          expiresAt: new Date(Date.now() + 60_000),
          consumedAt: null,
        },
      ]);
      mockHandleConsume([{ id: 'handle-1' }]); // atomic consume wins
      mockHandleDelete();

      const res = await fetchReq();
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.config).toEqual(CONFIG);

      // Handle was consumed AND hard-deleted (secrets don't linger at rest).
      expect(db.update).toHaveBeenCalled();
      expect(db.delete).toHaveBeenCalled();

      // Fetch is audited.
      expect(writeRouteAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'device.provision.fetch' }),
      );
    });

    it('404s a second fetch of an already-consumed handle', async () => {
      // Row exists but consume UPDATE returns empty (lost the single-use race).
      mockHandleSelect([
        {
          id: 'handle-1',
          orgId: ORG_ID,
          deviceId: 'device-prov-id',
          credentials: CONFIG,
          expiresAt: new Date(Date.now() + 60_000),
          consumedAt: null,
        },
      ]);
      mockHandleConsume([]); // already consumed by a prior fetch

      const res = await fetchReq();
      expect(res.status).toBe(404);
    });

    it('404s an unknown / nonexistent token', async () => {
      mockHandleSelect([]); // no row

      const res = await fetchReq();
      expect(res.status).toBe(404);
      // Never attempts a consume on a missing handle.
      expect(db.update).not.toHaveBeenCalled();
    });

    it('410s an expired handle and never returns the blob', async () => {
      mockHandleSelect([
        {
          id: 'handle-1',
          orgId: ORG_ID,
          deviceId: 'device-prov-id',
          credentials: CONFIG,
          expiresAt: new Date(Date.now() - 60_000), // already expired
          consumedAt: null,
        },
      ]);
      mockHandleDelete(); // best-effort cleanup of expired row

      const res = await fetchReq();
      expect(res.status).toBe(410);
      const body = await res.json();
      expect(body.config).toBeUndefined();
      // Expired handles are never consumed.
      expect(db.update).not.toHaveBeenCalled();
    });

    it('404s when the caller cannot access the handle owning org', async () => {
      setAuth({ canAccessOrg: () => false });
      mockHandleSelect([
        {
          id: 'handle-1',
          orgId: OTHER_ORG_ID,
          deviceId: 'device-prov-id',
          credentials: CONFIG,
          expiresAt: new Date(Date.now() + 60_000),
          consumedAt: null,
        },
      ]);

      const res = await fetchReq();
      expect(res.status).toBe(404);
      expect(db.update).not.toHaveBeenCalled();
    });

    it('400s a malformed token (fails pattern, no DB lookup)', async () => {
      const res = await fetchReq('not-a-valid-token');
      expect(res.status).toBe(400);
      expect(db.select).not.toHaveBeenCalled();
    });
  });
});
