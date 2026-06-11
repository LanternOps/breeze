import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

/**
 * Rig the transactional flow inside actuateElevation.ts.
 *
 * Options:
 *   - elevationRow: what tx.select(...).limit(1) returns. null = empty array
 *     (not_found path).
 *   - casWins: if true (default), the UPDATE returning() yields a row;
 *     if false, returns [] (race_lost path).
 *   - commandRow: the row returned by tx.insert(deviceCommands).returning().
 *
 * Returns:
 *   - commandValues: the values mock attached to deviceCommands inserts (last call wins)
 *   - auditInsertCalls: array of {table:'elevationAudit', values: <object>}
 *     so tests can assert which audit rows were written and with what details.
 */
function rigTransaction(opts: {
  elevationRow: typeof SAMPLE_ELEVATION | null;
  casWins?: boolean;
  commandRow?: Record<string, unknown>;
}) {
  const commandValues = vi.fn();
  const auditInsertCalls: Array<{ values: Record<string, unknown> }> = [];
  const updateSetCalls: Array<Record<string, unknown>> = [];

  vi.mocked(db.transaction).mockImplementation(async (cb: any) => {
    const tx: any = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue(opts.elevationRow ? [opts.elevationRow] : []),
          })),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn((vals: Record<string, unknown>) => {
          updateSetCalls.push(vals);
          return {
            where: vi.fn(() => ({
              returning: vi
                .fn()
                .mockResolvedValue(opts.casWins === false ? [] : [{ id: ELEVATION_ID }]),
            })),
          };
        }),
      })),
      // tx.insert is shared by deviceCommands inserts and elevationAudit inserts.
      // The route inserts elevationAudit with a different shape (no .returning())
      // and deviceCommands with .returning(). We resolve both by exposing both
      // chains and recording the values payload so tests can inspect.
      insert: vi.fn((tableRef: unknown) => {
        // The mocked schema/imports below give us identifiable table refs.
        // For the audit table, the chain is .values(...).then-able (no returning).
        // For deviceCommands the chain is .values(...).returning().
        return {
          values: vi.fn((vals: Record<string, unknown>) => {
            // Heuristic: deviceCommands rows carry `type` + `payload`, audit
            // rows carry `eventType`. Use that to bucket.
            if ((vals as any).eventType !== undefined) {
              auditInsertCalls.push({ values: vals });
              return Promise.resolve();
            }
            commandValues(vals);
            return {
              returning: vi
                .fn()
                .mockResolvedValue([
                  opts.commandRow ?? {
                    id: 'cmd-default',
                    deviceId: DEVICE_ID,
                    type: 'actuate_elevation',
                    status: 'pending',
                    createdAt: new Date(),
                  },
                ]),
            };
          }),
        };
      }),
    };
    return cb(tx);
  });

  return { commandValues, auditInsertCalls, updateSetCalls };
}

describe('POST /devices/:id/actuate-elevation', () => {
  let app: Hono;
  let savedPamEnv: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: enable the PAM actuator so existing tests continue to pass.
    savedPamEnv = process.env.PAM_ACTUATOR_ENABLED;
    process.env.PAM_ACTUATOR_ENABLED = 'true';
    setAuth();
    app = new Hono();
    app.route('/devices', actuateElevationRoutes);
  });

  afterEach(() => {
    if (savedPamEnv === undefined) {
      delete process.env.PAM_ACTUATOR_ENABLED;
    } else {
      process.env.PAM_ACTUATOR_ENABLED = savedPamEnv;
    }
  });

  describe('env guard (PAM_ACTUATOR_ENABLED)', () => {
    it('returns 403 and does NOT call db.transaction when PAM_ACTUATOR_ENABLED is unset', async () => {
      delete process.env.PAM_ACTUATOR_ENABLED;

      const res = await app.request(`/devices/${DEVICE_ID}/actuate-elevation`, {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          elevationRequestId: ELEVATION_ID,
          username: 'u',
          password: 'p',
        }),
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe('PAM actuator is disabled');
      expect(vi.mocked(db.transaction)).not.toHaveBeenCalled();
    });

    it('returns 403 and does NOT call db.transaction when PAM_ACTUATOR_ENABLED is "false"', async () => {
      process.env.PAM_ACTUATOR_ENABLED = 'false';

      const res = await app.request(`/devices/${DEVICE_ID}/actuate-elevation`, {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          elevationRequestId: ELEVATION_ID,
          username: 'u',
          password: 'p',
        }),
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe('PAM actuator is disabled');
      expect(vi.mocked(db.transaction)).not.toHaveBeenCalled();
    });

    it('passes through to route logic when PAM_ACTUATOR_ENABLED is "true"', async () => {
      process.env.PAM_ACTUATOR_ENABLED = 'true';
      // Device lookup returns nothing → 404, but crucially the guard did NOT block (403).
      vi.mocked(getDeviceWithOrgCheck).mockResolvedValue(undefined as never);

      const res = await app.request(`/devices/${DEVICE_ID}/actuate-elevation`, {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          elevationRequestId: ELEVATION_ID,
          username: 'u',
          password: 'p',
        }),
      });
      // 404 means the guard passed and route logic ran (device not found).
      expect(res.status).toBe(404);
    });
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
      rigTransaction({ elevationRow: null });

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

    it('returns 409 when elevation is not approved, and writes wrong_status audit', async () => {
      const { auditInsertCalls } = rigTransaction({
        elevationRow: { ...SAMPLE_ELEVATION, status: 'pending' as never },
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
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe('pending');

      // elevation_audit insert with rejected_wrong_status outcome
      expect(auditInsertCalls).toHaveLength(1);
      expect(auditInsertCalls[0]!.values).toMatchObject({
        orgId: ORG_ID,
        elevationRequestId: ELEVATION_ID,
        eventType: 'command_executed',
        actor: 'technician',
        actorUserId: USER_ID,
        details: expect.objectContaining({
          deviceId: DEVICE_ID,
          outcome: 'rejected_wrong_status',
          actualStatus: 'pending',
        }),
      });
    });

    it('returns 404 on elevation/device org mismatch (WHERE clause filters at DB)', async () => {
      // New transactional flow puts orgId in the WHERE clause, so an
      // elevation row in a different org never comes back from the select.
      // The handler treats that as not_found (404), not 409 — the previous
      // post-query org-mismatch branch is gone.
      rigTransaction({ elevationRow: null });

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

    it('returns 409 with race_lost and writes audit when the CAS update returns 0 rows', async () => {
      const { auditInsertCalls, commandValues } = rigTransaction({
        elevationRow: SAMPLE_ELEVATION,
        casWins: false,
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
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe('race_lost');

      // No command was queued
      expect(commandValues).not.toHaveBeenCalled();

      // Audit row with race_lost outcome was written
      expect(auditInsertCalls).toHaveLength(1);
      expect(auditInsertCalls[0]!.values).toMatchObject({
        orgId: ORG_ID,
        elevationRequestId: ELEVATION_ID,
        eventType: 'command_executed',
        actor: 'technician',
        actorUserId: USER_ID,
        details: expect.objectContaining({
          deviceId: DEVICE_ID,
          outcome: 'race_lost',
        }),
      });

      // Route-level audit also fired with race_lost
      expect(writeRouteAudit).toHaveBeenCalledTimes(1);
      const routeAudit = vi.mocked(writeRouteAudit).mock.calls[0]![1] as any;
      expect(routeAudit.details.outcome).toBe('race_lost');
    });
  });

  describe('happy path', () => {
    beforeEach(() => {
      vi.mocked(getDeviceWithOrgCheck).mockResolvedValue(SAMPLE_DEVICE as never);
    });

    it('queues actuate_elevation with full credential payload', async () => {
      const { commandValues } = rigTransaction({
        elevationRow: SAMPLE_ELEVATION,
        commandRow: {
          id: 'cmd-1',
          deviceId: DEVICE_ID,
          type: 'actuate_elevation',
          status: 'pending',
          createdAt: new Date(),
        },
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
      expect(commandValues).toHaveBeenCalledWith(
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
      const { commandValues } = rigTransaction({
        elevationRow: SAMPLE_ELEVATION,
        commandRow: {
          id: 'cmd-2',
          deviceId: DEVICE_ID,
          type: 'actuate_elevation',
          status: 'pending',
          createdAt: new Date(),
        },
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
      expect(commandValues).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({ timeoutMs: 8000 }),
        }),
      );
    });

    it('writes audit without the password and an elevation_audit happy-path row', async () => {
      const { auditInsertCalls } = rigTransaction({
        elevationRow: SAMPLE_ELEVATION,
        commandRow: {
          id: 'cmd-3',
          deviceId: DEVICE_ID,
          type: 'actuate_elevation',
          status: 'pending',
          createdAt: new Date(),
        },
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

      // elevation_audit row written inside the transaction, also password-free
      expect(auditInsertCalls).toHaveLength(1);
      const txAudit = auditInsertCalls[0]!.values as any;
      expect(txAudit.eventType).toBe('command_executed');
      expect(txAudit.details).toMatchObject({
        deviceId: DEVICE_ID,
        commandId: 'cmd-3',
        username: 'svc-admin',
        timeoutMs: 8000,
      });
      expect(JSON.stringify(txAudit)).not.toContain('do-not-log-me');
    });
  });
});
