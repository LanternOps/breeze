import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const {
  authMiddlewareMock,
  requireScopeMock,
  requirePermissionMock,
  requireMfaMock,
} = vi.hoisted(() => ({
  authMiddlewareMock: vi.fn(),
  requireScopeMock: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermissionMock: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfaMock: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
    insert: vi.fn(),
  },
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: authMiddlewareMock,
  requireScope: requireScopeMock,
  requirePermission: requirePermissionMock,
  requireMfa: requireMfaMock,
}));

vi.mock('./helpers', () => ({
  getDeviceWithOrgCheck: vi.fn(),
}));

vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

import { db } from '../../db';
import { getDeviceWithOrgCheck } from './helpers';
import { writeRouteAudit } from '../../services/auditEvents';
import { actuateElevationRoutes } from './actuateElevation';

// Snapshot gate registration BEFORE beforeEach's clearAllMocks. Same
// pattern as moveOrg.test.ts — middleware factories run at module-import
// time so by the first test the calls are already captured.
const registeredScopeCalls: string[][] = (
  requireScopeMock.mock.calls as unknown as unknown[][]
).map((c) => c.flat().map((v) => String(v)));
const registeredPermResources: string[] = (
  requirePermissionMock.mock.calls as unknown as unknown[][]
).map((c) => c.map((v) => String(v)).join(':'));
const registeredMfaCallCount = requireMfaMock.mock.calls.length;

const ORG_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEVICE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ELEVATION_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const USER_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const SAMPLE_DEVICE = {
  id: DEVICE_ID,
  orgId: ORG_ID,
  siteId: null,
  hostname: 'host-1',
  status: 'online' as const,
};

const SAMPLE_ELEVATION = {
  id: ELEVATION_ID,
  deviceId: DEVICE_ID,
  orgId: ORG_ID,
  status: 'approved' as const,
};

function setAuth() {
  authMiddlewareMock.mockImplementation((c: any, next: any) => {
    c.set('auth', {
      user: { id: USER_ID, email: 't@example.com' },
      scope: 'partner',
      orgId: ORG_ID,
      canAccessOrg: () => true,
    });
    return next();
  });
}

function rigElevationSelect(row: typeof SAMPLE_ELEVATION | null) {
  const limit = vi.fn().mockResolvedValue(row ? [row] : []);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  vi.mocked(db.select).mockReturnValue({ from } as never);
}

function rigInsertSuccess(commandRow: Record<string, unknown>) {
  const returning = vi.fn().mockResolvedValue([commandRow]);
  const values = vi.fn().mockReturnValue({ returning });
  vi.mocked(db.insert).mockReturnValue({ values } as never);
  return { values, returning };
}

describe('POST /devices/:id/actuate-elevation', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    setAuth();
    app = new Hono();
    app.route('/devices', actuateElevationRoutes);
  });

  describe('gate registration', () => {
    it('requires organization+ scope, devices:execute, and MFA', () => {
      expect(
        registeredScopeCalls.some(
          (a) => a.includes('organization') && a.includes('partner') && a.includes('system'),
        ),
      ).toBe(true);
      expect(registeredPermResources).toContain('devices:execute');
      expect(registeredMfaCallCount).toBeGreaterThan(0);
    });
  });

  describe('input validation', () => {
    it('rejects missing elevationRequestId', async () => {
      const res = await app.request(`/devices/${DEVICE_ID}/actuate-elevation`, {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'u', password: 'p' }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects non-UUID elevationRequestId', async () => {
      const res = await app.request(`/devices/${DEVICE_ID}/actuate-elevation`, {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          elevationRequestId: 'not-a-uuid',
          username: 'u',
          password: 'p',
        }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects timeoutMs above 60000', async () => {
      const res = await app.request(`/devices/${DEVICE_ID}/actuate-elevation`, {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          elevationRequestId: ELEVATION_ID,
          username: 'u',
          password: 'p',
          timeoutMs: 999999,
        }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('authorization', () => {
    it('returns 404 when device not visible to caller', async () => {
      vi.mocked(getDeviceWithOrgCheck).mockResolvedValue(undefined as never);

      const res = await app.request(`/devices/${DEVICE_ID}/actuate-elevation`, {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          elevationRequestId: ELEVATION_ID,
          username: 'svc-admin',
          password: 'super-secret',
        }),
      });
      expect(res.status).toBe(404);
    });

    it('rejects decommissioned devices', async () => {
      vi.mocked(getDeviceWithOrgCheck).mockResolvedValue({
        ...SAMPLE_DEVICE,
        status: 'decommissioned',
      } as never);

      const res = await app.request(`/devices/${DEVICE_ID}/actuate-elevation`, {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          elevationRequestId: ELEVATION_ID,
          username: 'u',
          password: 'p',
        }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('elevation row preconditions', () => {
    beforeEach(() => {
      vi.mocked(getDeviceWithOrgCheck).mockResolvedValue(SAMPLE_DEVICE as never);
    });

    it('returns 404 when elevation row is missing', async () => {
      rigElevationSelect(null);

      const res = await app.request(`/devices/${DEVICE_ID}/actuate-elevation`, {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          elevationRequestId: ELEVATION_ID,
          username: 'u',
          password: 'p',
        }),
      });
      expect(res.status).toBe(404);
    });

    it('returns 409 when elevation is not approved', async () => {
      rigElevationSelect({ ...SAMPLE_ELEVATION, status: 'pending' as never });

      const res = await app.request(`/devices/${DEVICE_ID}/actuate-elevation`, {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          elevationRequestId: ELEVATION_ID,
          username: 'u',
          password: 'p',
        }),
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe('pending');
    });

    it('returns 409 on elevation/device org mismatch', async () => {
      rigElevationSelect({ ...SAMPLE_ELEVATION, orgId: 'other-org' });

      const res = await app.request(`/devices/${DEVICE_ID}/actuate-elevation`, {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          elevationRequestId: ELEVATION_ID,
          username: 'u',
          password: 'p',
        }),
      });
      expect(res.status).toBe(409);
    });
  });

  describe('happy path', () => {
    beforeEach(() => {
      vi.mocked(getDeviceWithOrgCheck).mockResolvedValue(SAMPLE_DEVICE as never);
      rigElevationSelect(SAMPLE_ELEVATION);
    });

    it('queues actuate_elevation with full credential payload', async () => {
      const { values } = rigInsertSuccess({
        id: 'cmd-1',
        deviceId: DEVICE_ID,
        type: 'actuate_elevation',
        status: 'pending',
        createdAt: new Date(),
      });

      const res = await app.request(`/devices/${DEVICE_ID}/actuate-elevation`, {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          elevationRequestId: ELEVATION_ID,
          username: 'DOMAIN\\svc-admin',
          password: 'one-time',
          timeoutMs: 5000,
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body).toMatchObject({
        id: 'cmd-1',
        type: 'actuate_elevation',
        status: 'pending',
        elevationRequestId: ELEVATION_ID,
      });
      expect(values).toHaveBeenCalledWith(
        expect.objectContaining({
          deviceId: DEVICE_ID,
          type: 'actuate_elevation',
          status: 'pending',
          createdBy: USER_ID,
          payload: expect.objectContaining({
            elevationRequestId: ELEVATION_ID,
            username: 'DOMAIN\\svc-admin',
            password: 'one-time',
            timeoutMs: 5000,
          }),
        }),
      );
    });

    it('applies the default 8000ms timeout when omitted', async () => {
      const { values } = rigInsertSuccess({
        id: 'cmd-2',
        deviceId: DEVICE_ID,
        type: 'actuate_elevation',
        status: 'pending',
        createdAt: new Date(),
      });

      const res = await app.request(`/devices/${DEVICE_ID}/actuate-elevation`, {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          elevationRequestId: ELEVATION_ID,
          username: 'u',
          password: 'p',
        }),
      });

      expect(res.status).toBe(201);
      expect(values).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({ timeoutMs: 8000 }),
        }),
      );
    });

    it('writes audit without the password', async () => {
      rigInsertSuccess({
        id: 'cmd-3',
        deviceId: DEVICE_ID,
        type: 'actuate_elevation',
        status: 'pending',
        createdAt: new Date(),
      });

      await app.request(`/devices/${DEVICE_ID}/actuate-elevation`, {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          elevationRequestId: ELEVATION_ID,
          username: 'svc-admin',
          password: 'do-not-log-me',
        }),
      });

      expect(writeRouteAudit).toHaveBeenCalledTimes(1);
      const auditPayload = vi.mocked(writeRouteAudit).mock.calls[0]![1] as any;
      expect(auditPayload.action).toBe('device.elevation.actuate');
      expect(auditPayload.details.username).toBe('svc-admin');
      expect(JSON.stringify(auditPayload)).not.toContain('do-not-log-me');
    });
  });
});
