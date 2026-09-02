import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { deviceRoutes } from '../routes/devices';
import { createAuthenticatedClient, createTestDevice, createTestUser } from './helpers';

const mockQueueCommand = vi.fn();

vi.mock('../services/commandQueue', () => ({
  queueCommand: (...args: unknown[]) => mockQueueCommand(...args)
}));

vi.mock('../services/auditEvents', () => ({
  requestLikeFromSnapshot: vi.fn(() => ({ req: { header: () => undefined } })),
  writeAuditEvent: vi.fn(),
  writeRouteAudit: vi.fn()
}));

vi.mock('../services/permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/permissions')>();
  return {
    ...actual,
    getUserPermissions: vi.fn(async () => ({ permissions: [{ resource: '*', action: '*' }] })),
    hasPermission: vi.fn(() => true),
    canAccessOrg: vi.fn(() => true),
    canAccessSite: vi.fn(() => true),
  };
});

vi.mock('../services/enrollmentKeySecurity', () => ({
  hashEnrollmentKey: vi.fn((key: string) => `hashed-${key}`),
  hashEnrollmentKeyCandidates: vi.fn((key: string) => [`hashed-${key}`]),
  generateEnrollmentKey: vi.fn(() => 'ek_test123')
}));

vi.mock('../services/remoteAccessPolicy', () => ({
  checkRemoteAccess: vi.fn().mockResolvedValue({ allowed: true }),
  resolveRemoteAccessForDevice: vi.fn().mockResolvedValue({
    settings: { webrtcDesktop: true, vncRelay: true, remoteTools: true, enableProxy: true, defaultAllowedPorts: [], autoEnableProxy: false, maxConcurrentTunnels: 5, idleTimeoutMinutes: 5, maxSessionDurationHours: 8 },
    policyName: null,
    policyId: null,
  }),
}));

// Bypass tenant active-status checks (queries organizations/partners which the
// simple db mock can't reasonably emulate). Real check runs in authMiddleware
// after SR-001..SR-024 hardening landed (see services/tenantStatus.ts).
vi.mock('../services/tenantStatus', () => ({
  TenantInactiveError: class TenantInactiveError extends Error {},
  assertActiveTenantContext: vi.fn(async () => {}),
  getActivePartner: vi.fn(async (id: string) => ({ id })),
  getActiveOrgTenant: vi.fn(async (id: string) => ({ orgId: id, partnerId: 'test-partner-id' })),
}));

// Bypass token revocation lookup (Redis-backed).
vi.mock('../services/tokenRevocation', () => ({
  isUserTokenRevoked: vi.fn(async () => false),
  revokeUserTokens: vi.fn(async () => {}),
  isTokenIssuedBeforePasswordChange: vi.fn(() => false),
}));

// RMM-QA-176: grant storage is Redis-backed, and this suite has no Redis — a
// real validate would fail closed (403) for the ADMISSION case too, which
// would make the denial cases unfalsifiable. PARTIAL on purpose:
// maintenanceResourceDigest stays REAL, so the route still computes the
// production canonicalization. The gates under test (authMiddleware,
// requireInteractiveSession, requireMfa) are all untouched.
vi.mock('../services/mfaStepUpGrant', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/mfaStepUpGrant')>();
  return {
    ...actual,
    validateStepUpGrant: vi.fn(async () => true),
    consumeStepUpGrant: vi.fn(async () => true),
  };
});

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Object.assign(Promise.resolve([]), {
          limit: vi.fn(() => Promise.resolve([]))
        }))
      }))
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([]))
      }))
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(() => Promise.resolve([]))
        }))
      }))
    })),
    // RMM-QA-176: the maintenance route now writes through db.transaction
    // (services/deviceMaintenanceLease). Without this key the route 500s with
    // "db.transaction is not a function" — which is how the pre-Task-9 RED
    // presented for the exit case.
    transaction: vi.fn()
  },
  withDbAccessContext: vi.fn(async (_ctx: any, fn: any) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: any) => fn()),
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  SYSTEM_DB_ACCESS_CONTEXT: { scope: 'system', orgId: null, accessibleOrgIds: null }
}));

vi.mock('../db/schema', () => ({
  users: { id: 'id', email: 'email', name: 'name', status: 'status', mfaEnabled: 'mfaEnabled' },
  devices: { id: 'id', orgId: 'orgId' },
  deviceCommands: { deviceId: 'deviceId', status: 'status', createdAt: 'createdAt' },
  alerts: { deviceId: 'deviceId', status: 'status', triggeredAt: 'triggeredAt' },
  alertRules: {},
  alertTemplates: {},
  organizations: {},
  partnerUsers: {},
  organizationUsers: {},
  roles: { id: 'roles.id', forceMfa: 'roles.forceMfa' },
  deviceHardware: {},
  deviceNetwork: {},
  deviceMetrics: {},
  deviceSoftware: {},
  deviceGroups: {},
  deviceGroupMemberships: {},
  enrollmentKeys: {},
  sites: {},
  patchPolicies: {},
  backupConfigs: {},
  securityPolicies: {},
  automationPolicies: {},
  maintenanceWindows: {},
  softwarePolicies: {},
  sensitiveDataPolicies: {},
  peripheralPolicies: {},
  deviceStatusEnum: { enumValues: ['online', 'offline', 'maintenance', 'decommissioned', 'quarantined', 'updating', 'pending'] },
  osTypeEnum: { enumValues: ['windows', 'macos', 'linux'] },
  discoveredAssetTypeEnum: { enumValues: ['workstation', 'server', 'printer', 'unknown'] }
}));

import { db } from '../db';

function mockUserLookup(user = createTestUser()) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue([user])
      })
    })
  } as any);
}

function mockDeviceLookup(device: ReturnType<typeof createTestDevice> | null) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(device ? [device] : [])
      })
    })
  } as any);
}

describe('device endpoints (authenticated)', () => {
  let app: Hono;

  beforeEach(() => {
    // resetAllMocks clears mockReturnValueOnce queue to prevent test pollution
    vi.resetAllMocks();
    // Restore factory defaults after reset
    vi.mocked(db.select).mockImplementation(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Object.assign(Promise.resolve([]), {
          limit: vi.fn(() => Promise.resolve([])),
          orderBy: vi.fn(() => ({
            limit: vi.fn(() => ({
              offset: vi.fn(() => Promise.resolve([]))
            }))
          }))
        }))
      }))
    }) as any);
    vi.mocked(db.insert).mockImplementation(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([]))
      }))
    }) as any);
    vi.mocked(db.update).mockImplementation(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(() => Promise.resolve([]))
        }))
      }))
    }) as any);
    mockQueueCommand.mockReset();
    app = new Hono();
    app.route('/devices', deviceRoutes);
  });

  describe('POST /devices/bulk/commands', () => {
    it('should queue commands for multiple devices', async () => {
      const deviceOne = createTestDevice({ id: '00000000-0000-0000-0000-000000000001', status: 'online' });
      const deviceTwo = createTestDevice({ id: '00000000-0000-0000-0000-000000000002', status: 'offline' });
      const deviceThree = createTestDevice({ id: '00000000-0000-0000-0000-000000000003', status: 'decommissioned' });

      mockUserLookup();
      mockDeviceLookup(deviceOne);
      mockDeviceLookup(deviceTwo);
      mockDeviceLookup(deviceThree);

      // The bulk command handler uses db.insert().values().returning() for each device
      vi.mocked(db.insert)
        .mockReturnValueOnce({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{
              id: 'cmd-1',
              deviceId: deviceOne.id,
              type: 'reboot',
              status: 'pending',
              createdAt: new Date()
            }])
          })
        } as any)
        .mockReturnValueOnce({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{
              id: 'cmd-2',
              deviceId: deviceTwo.id,
              type: 'reboot',
              status: 'pending',
              createdAt: new Date()
            }])
          })
        } as any);

      const client = await createAuthenticatedClient(app, { mfa: true });
      const res = await client.post('/devices/bulk/commands', {
        deviceIds: [deviceOne.id, deviceTwo.id, deviceThree.id],
        type: 'reboot'
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.commands).toHaveLength(2);
      expect(body.failed).toEqual([
        {
          deviceId: deviceThree.id,
          code: 'DECOMMISSIONED',
          message: 'Cannot send commands to a decommissioned device.',
        },
      ]);
      expect(body.commands.map((command: { deviceId: string }) => command.deviceId)).toEqual([
        deviceOne.id,
        deviceTwo.id
      ]);
    });
  });

  describe('POST /devices/:id/maintenance', () => {
    // This suite mints a REAL token (helpers.ts createTestToken) and runs the
    // REAL authMiddleware, so `mfa` here is an actual JWT claim, not a mocked
    // context field. That is what makes it a different proof from
    // routes/devices/commands.test.ts and worth keeping.
    //
    // RMM-QA-176: `should enable maintenance mode` used to assert a 200 for the
    // DEFAULT token, whose mfa claim is false (helpers.ts:93). A passing
    // assertion that a non-assured session may suppress monitoring IS the
    // finding, written down. It is replaced by the denial below, and the 200 is
    // now claimed only by an assured session presenting a grant.
    const DEVICE_ID = '11111111-2222-4333-8444-555555555555';

    /**
     * getUserEpochs (services/authEpochs) reads users.auth_epoch/mfa_epoch
     * through db.select — the THIRD select of an entry request (authMiddleware's
     * user lookup, then the route's device lookup, then this). Queue it or the
     * route answers 503 before it ever reaches the step-up check.
     */
    function mockEpochsLookup() {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ authEpoch: 1, mfaEpoch: 1 }])
          })
        })
      } as any);
    }

    /**
     * Drives services/deviceMaintenanceLease against a recording stub tx:
     * locked select, then exactly one UPDATE ... RETURNING. Returns the array of
     * value-sets the route actually wrote, so an admission case can assert the
     * write LANDED and what it contained — a 200 on its own would not.
     */
    function stubLeaseTransaction(device: Record<string, unknown>) {
      const written: Array<Record<string, unknown>> = [];
      vi.mocked(db.transaction).mockImplementationOnce(async (fn: any) => fn({
        select: () => ({ from: () => ({ where: () => ({ limit: () => ({ for: async () => [device] }) }) }) }),
        update: () => ({
          set: (values: Record<string, unknown>) => {
            written.push(values);
            return { where: () => ({ returning: async () => [{ ...device, ...values }] }) };
          },
        }),
      }));
      return written;
    }

    it('denies entry from a non-assured session and writes nothing (was: a 200 — the finding)', async () => {
      const device = createTestDevice({ id: DEVICE_ID, status: 'online' });
      mockUserLookup();
      mockDeviceLookup(device);

      // Default token: mfa:false (helpers.ts:93). On main this returned 200.
      const client = await createAuthenticatedClient(app);
      const res = await client.post(`/devices/${device.id}/maintenance`, {
        enable: true,
        reason: 'scheduled patching',
        durationHours: 2,
      });

      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'MFA_REQUIRED' });
      expect(db.update).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('rejects the OLD body shape (no reason) even from an assured session', async () => {
      const device = createTestDevice({ id: DEVICE_ID, status: 'online' });
      mockUserLookup();
      mockDeviceLookup(device);

      const client = await createAuthenticatedClient(app, { mfa: true });
      const res = await client.post(`/devices/${device.id}/maintenance`, { enable: true, durationHours: 2 });

      expect(res.status).toBe(400);
      expect(db.update).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('denies an assured session with NO step-up grant and writes nothing', async () => {
      const device = createTestDevice({ id: DEVICE_ID, status: 'online' });
      mockUserLookup();
      mockDeviceLookup(device);
      mockEpochsLookup();

      const client = await createAuthenticatedClient(app, { mfa: true });
      const res = await client.post(`/devices/${device.id}/maintenance`, {
        enable: true,
        reason: 'scheduled patching',
        durationHours: 2,
      });

      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'STEP_UP_REQUIRED' });
      expect(db.update).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('admits an assured session presenting a valid grant and WRITES the lease', async () => {
      const device = createTestDevice({ id: DEVICE_ID, status: 'online' });
      mockUserLookup();
      mockDeviceLookup(device);
      mockEpochsLookup();
      const written = stubLeaseTransaction(device);

      const client = await createAuthenticatedClient(app, { mfa: true });
      const res = await client.post(`/devices/${device.id}/maintenance`, {
        enable: true,
        reason: 'scheduled patching',
        durationHours: 2,
        stepUpGrant: '11111111-1111-4111-8111-111111111111',
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ success: true, action: 'enable' });
      // The admission's PROOF is the write, not the status code.
      expect(written).toHaveLength(1);
      expect(written[0]).toMatchObject({
        status: 'maintenance',
        maintenanceReason: 'scheduled patching',
        maintenanceStartedBy: 'test-user-id',
      });
      expect(written[0]!.maintenanceUntil).toBeInstanceOf(Date);
      expect(written[0]!.maintenanceStartedAt).toBeInstanceOf(Date);
    });

    it('exits maintenance without MFA and without a grant, clearing the lease', async () => {
      const device = createTestDevice({
        id: '22222222-3333-4444-8555-666666666666',
        status: 'maintenance',
        lastSeenAt: new Date(),
        maintenanceUntil: new Date(Date.now() + 3_600_000),
        maintenanceStartedAt: new Date(Date.now() - 3_600_000),
        maintenanceReason: 'scheduled patching',
        maintenanceStartedBy: 'test-user-id',
      });
      mockUserLookup();
      mockDeviceLookup(device);
      const written = stubLeaseTransaction(device);

      const client = await createAuthenticatedClient(app); // mfa:false on purpose
      const res = await client.post(`/devices/${device.id}/maintenance`, { enable: false });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ success: true, changed: true });
      expect(written).toHaveLength(1);
      expect(written[0]).toMatchObject({
        status: 'online',
        maintenanceUntil: null,
        maintenanceReason: null,
        maintenanceStartedAt: null,
        maintenanceStartedBy: null,
      });
    });

    it('rejects an X-API-Key-only request at authMiddleware and writes nothing', async () => {
      // /devices is mounted under the JWT authMiddleware only (index.ts:840) —
      // no apiKeyAuthMiddleware branch — so an API key never reaches the route
      // at all. Asserted here rather than assumed: if a future PR mounts an
      // API-key branch under /devices, this test is what notices.
      const device = createTestDevice({ id: DEVICE_ID, status: 'online' });
      mockUserLookup();
      mockDeviceLookup(device);

      const res = await app.request(`/devices/${device.id}/maintenance`, {
        method: 'POST',
        headers: { 'X-API-Key': 'brz_test_key', 'Content-Type': 'application/json' },
        body: JSON.stringify({ enable: true, reason: 'scheduled patching', durationHours: 2 }),
      });

      expect(res.status).toBe(401);
      expect(db.update).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
    });
  });

  describe('GET /devices/:id/alerts', () => {
    it('should return alerts for a device', async () => {
      const device = createTestDevice({ id: '11111111-2222-4333-8444-555555555555' });
      const mockAlert = {
        id: 'alert-1',
        title: 'High CPU',
        message: 'CPU at 95%',
        severity: 'warning',
        status: 'active',
        triggeredAt: new Date(),
        acknowledgedAt: null,
        resolvedAt: null,
        ruleName: 'cpu-rule',
        templateName: 'cpu-template'
      };

      mockUserLookup();
      mockDeviceLookup(device);
      // Alerts query: db.select().from(alerts).leftJoin().leftJoin().where().orderBy().limit()
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            leftJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                orderBy: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue([mockAlert])
                })
              })
            })
          })
        })
      } as any);

      const client = await createAuthenticatedClient(app);
      const res = await client.get(`/devices/${device.id}/alerts?limit=10`);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].id).toBe('alert-1');
    });
  });
});
