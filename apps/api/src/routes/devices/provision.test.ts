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

function setAuth(overrides: Partial<{ canAccessOrg: (id: string) => boolean }> = {}) {
  authMiddlewareMock.mockImplementation((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-1', email: 'a@example.com' },
      canAccessOrg: overrides.canAccessOrg ?? ((id: string) => id === ORG_ID),
    });
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
    it('creates a device and returns the config blob', async () => {
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

      const res = await app.request('/devices/provision', {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify(BASE_BODY),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.device.id).toBe('device-prov-id');
      expect(body.config).toMatchObject({
        agent_id: 'agent-prov-1',
        server_url: 'https://breeze.example.com',
        org_id: ORG_ID,
        site_id: SITE_ID,
        auth_token: 'brz_prov_token',
      });
      expect(body.config.manifest_trust_keys).toEqual([]);

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
});
