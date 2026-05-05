import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// ---------- mocks ----------

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
  },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../db/schema', () => ({
  enrollmentKeys: {
    id: 'id',
    orgId: 'orgId',
    siteId: 'siteId',
    key: 'key',
    keySecretHash: 'keySecretHash',
    expiresAt: 'expiresAt',
    maxUsage: 'maxUsage',
    usageCount: 'usageCount',
  },
  devices: {
    id: 'id',
    hostname: 'hostname',
    orgId: 'orgId',
    siteId: 'siteId',
    status: 'status',
    agentTokenHash: 'agentTokenHash',
    previousTokenHash: 'previousTokenHash',
    previousTokenExpiresAt: 'previousTokenExpiresAt',
  },
  deviceHardware: { deviceId: 'deviceId', serialNumber: 'serialNumber' },
  deviceNetwork: { deviceId: 'deviceId', macAddress: 'macAddress' },
  organizations: { id: 'id', partnerId: 'partnerId' },
  partners: { id: 'id', maxDevices: 'maxDevices' },
}));

vi.mock('../../services/auditEvents', () => ({
  writeAuditEvent: vi.fn(),
}));

vi.mock('../../services/enrollmentKeySecurity', () => ({
  hashEnrollmentKey: vi.fn((k: string) => `hashed:${k}`),
  hashEnrollmentKeyCandidates: vi.fn((k: string) => [`hashed:${k}`]),
}));

vi.mock('../../services/clientIp', () => ({
  getTrustedClientIp: vi.fn(() => '127.0.0.1'),
}));

vi.mock('../../services/redis', () => ({
  getRedis: vi.fn(() => ({})),
}));

vi.mock('../../services/rate-limit', () => ({
  rateLimiter: vi.fn(async () => ({ allowed: true, resetAt: new Date(Date.now() + 60000) })),
}));

vi.mock('./helpers', () => ({
  generateAgentId: vi.fn(() => 'agent-id-1'),
  generateApiKey: vi.fn(() => 'brz_token'),
  issueMtlsCertForDevice: vi.fn(async () => null),
}));

vi.mock('../../services/warrantyWorker', () => ({
  queueWarrantySyncForDevice: vi.fn(),
}));

vi.mock('../../services/partnerHooks', () => ({
  dispatchHook: vi.fn(),
}));

// ---------- imports after mocks ----------

import { db } from '../../db';
import { writeAuditEvent } from '../../services/auditEvents';
import { enrollmentRoutes } from './enrollment';

function buildApp(): Hono {
  const app = new Hono();
  app.route('/agents', enrollmentRoutes);
  return app;
}

const baseEnrollBody = {
  enrollmentKey: 'e2e-test-key',
  hostname: 'host-1',
  osType: 'windows',
  osVersion: 'Windows Server 2022',
  architecture: 'amd64',
  agentVersion: '0.62.24',
  deviceRole: 'server',
};

function mockKeyLookup(row: Record<string, unknown> | undefined) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn().mockResolvedValue(row ? [row] : []),
      })),
    })),
  } as any);
}

function mockSelectRows(rows: Record<string, unknown>[]) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn().mockResolvedValue(rows),
      })),
    })),
  } as any);
}

// ---------- tests ----------

describe('POST /agents/enroll — 401 reason disambiguation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.AGENT_ENROLLMENT_SECRET;
    process.env.NODE_ENV = 'test';
  });

  it('returns reason=enrollment_key_not_found when the hash has no matching row', async () => {
    mockKeyLookup(undefined);

    const resp = await buildApp().request('/agents/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseEnrollBody),
    });

    expect(resp.status).toBe(401);
    const body = await resp.json();
    expect(body).toEqual({
      error: 'Enrollment key not recognized',
      reason: 'enrollment_key_not_found',
    });
    expect(writeAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        details: { reason: 'enrollment_key_not_found' },
        result: 'denied',
      })
    );
  });

  it('returns reason=enrollment_key_expired when the row exists but expiresAt is in the past', async () => {
    mockKeyLookup({
      id: 'key-1',
      orgId: 'org-1',
      siteId: 'site-1',
      keySecretHash: null,
      expiresAt: new Date(Date.now() - 60_000),
      maxUsage: null,
      usageCount: 0,
    });

    const resp = await buildApp().request('/agents/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseEnrollBody),
    });

    expect(resp.status).toBe(401);
    const body = await resp.json();
    expect(body.reason).toBe('enrollment_key_expired');
    expect(body.error).toContain('expired');
    expect(writeAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId: 'org-1',
        details: { reason: 'enrollment_key_expired', keyId: 'key-1' },
      })
    );
  });

  it('returns reason=enrollment_key_exhausted when usageCount >= maxUsage', async () => {
    mockKeyLookup({
      id: 'key-2',
      orgId: 'org-2',
      siteId: 'site-2',
      keySecretHash: null,
      expiresAt: new Date(Date.now() + 3600_000),
      maxUsage: 3,
      usageCount: 3,
    });

    const resp = await buildApp().request('/agents/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseEnrollBody),
    });

    expect(resp.status).toBe(401);
    const body = await resp.json();
    expect(body.reason).toBe('enrollment_key_exhausted');
    expect(body.error).toContain('maximum usage');
    expect(writeAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId: 'org-2',
        details: { reason: 'enrollment_key_exhausted', keyId: 'key-2' },
      })
    );
  });

  it('accepts a valid (unexpired, non-exhausted) row and does not return 401 at the lookup stage', async () => {
    // Valid lookup → then downstream update fetch returns no row → race-lost branch.
    // We just want to assert the 401 reason is NOT one of the three above.
    mockKeyLookup({
      id: 'key-3',
      orgId: 'org-3',
      siteId: 'site-3',
      keySecretHash: null,
      expiresAt: new Date(Date.now() + 3600_000),
      maxUsage: 10,
      usageCount: 0,
    });

    // Downstream update: return empty (race condition path) so we stop there
    vi.mocked(db.update).mockReturnValueOnce({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue([]),
        })),
      })),
    } as any);

    const resp = await buildApp().request('/agents/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseEnrollBody),
    });

    expect(resp.status).toBe(401);
    const body = await resp.json();
    expect(body.reason).toBe('enrollment_key_race_lost');
  });

  it('denies hostname collision when the existing device token is absent and hardware identity conflicts', async () => {
    mockKeyLookup({
      id: 'key-4',
      orgId: 'org-4',
      siteId: 'site-4',
      keySecretHash: null,
      expiresAt: new Date(Date.now() + 3600_000),
      maxUsage: 10,
      usageCount: 0,
    });

    vi.mocked(db.update).mockReturnValueOnce({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue([{
            id: 'key-4',
            orgId: 'org-4',
            siteId: 'site-4',
          }]),
        })),
      })),
    } as any);

    mockSelectRows([{ partnerId: 'partner-4' }]);
    mockSelectRows([{ maxDevices: null }]);
    mockSelectRows([{
      id: 'device-existing',
      status: 'online',
      agentTokenHash: 'existing-token-hash',
      previousTokenHash: null,
      previousTokenExpiresAt: null,
    }]);
    const resp = await buildApp().request('/agents/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...baseEnrollBody,
        hardwareInfo: { serialNumber: 'SERIAL-ATTACKER' },
        networkInfo: [{ name: 'eth0', mac: '66:77:88:99:aa:bb' }],
      }),
    });

    expect(resp.status).toBe(409);
    const body = await resp.json();
    expect(body.reason).toBe('hostname_collision_requires_existing_device_token');
    expect(writeAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        resourceId: 'device-existing',
        result: 'denied',
        details: expect.objectContaining({
          reason: 'hostname_collision_requires_existing_device_token',
        }),
      })
    );
  });

  it('denies hostname collision even when self-attested hardware identity matches', async () => {
    mockKeyLookup({
      id: 'key-5',
      orgId: 'org-5',
      siteId: 'site-5',
      keySecretHash: null,
      expiresAt: new Date(Date.now() + 3600_000),
      maxUsage: 10,
      usageCount: 0,
    });

    vi.mocked(db.update).mockReturnValueOnce({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue([{
            id: 'key-5',
            orgId: 'org-5',
            siteId: 'site-5',
          }]),
        })),
      })),
    } as any);

    mockSelectRows([{ partnerId: 'partner-5' }]);
    mockSelectRows([{ maxDevices: null }]);
    mockSelectRows([{
      id: 'device-existing',
      status: 'online',
      agentTokenHash: 'existing-token-hash',
      previousTokenHash: null,
      previousTokenExpiresAt: null,
    }]);

    const resp = await buildApp().request('/agents/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...baseEnrollBody,
        hardwareInfo: { serialNumber: 'SERIAL-EXISTING' },
        networkInfo: [{ name: 'eth0', mac: '00:11:22:33:44:55' }],
      }),
    });

    expect(resp.status).toBe(409);
    const body = await resp.json();
    expect(body.reason).toBe('hostname_collision_requires_existing_device_token');
  });
});
