import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { Hono } from 'hono';
import { createHash } from 'node:crypto';

// ---------- mocks ----------

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
    transaction: vi.fn(),
  },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../services/manifestSigning', () => ({
  getActiveTrustKeyset: vi.fn(async () => []),
  getActiveManifestKeyDelegations: vi.fn(async () => []),
}));

vi.mock('../../modules/mcpInvites/matchInviteOnEnrollment', () => ({
  matchDeploymentInviteOnEnrollment: vi.fn(async () => undefined),
}));

vi.mock('../../services/sentry', () => ({
  captureException: vi.fn(),
}));

vi.mock('../../services/anomalyMetrics', () => ({
  recordAgentEnrollment: vi.fn(),
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
    supportSessionId: 'supportSessionId',
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
    agentTokenSuspendedAt: 'agentTokenSuspendedAt',
    possibleReplacementOfDeviceId: 'possibleReplacementOfDeviceId',
    enrollmentIp: 'enrollment_ip',
    createdAt: 'createdAt',
    isEphemeral: 'devices.isEphemeral',
  },
  deviceHardware: { deviceId: 'deviceId', serialNumber: 'serialNumber' },
  deviceNetwork: { deviceId: 'deviceId', macAddress: 'macAddress' },
  organizations: { id: 'id', partnerId: 'partnerId' },
  partners: {
    id: 'id',
    maxDevices: 'maxDevices',
    trustState: 'trustState',
    probationEnrollments: 'probationEnrollments',
  },
  supportSessions: {
    id: 'supportSessions.id',
    status: 'supportSessions.status',
    hardExpiresAt: 'supportSessions.hardExpiresAt',
    deviceId: 'supportSessions.deviceId',
  },
}));

vi.mock('../../services/auditEvents', () => ({
  writeAuditEvent: vi.fn(),
}));

vi.mock('../../services/enrollmentKeySecurity', async () => {
  // Dynamic import: vi.mock factories are hoisted above the file's imports.
  const { createHash: sha } = await import('node:crypto');
  return {
    hashEnrollmentKey: vi.fn((k: string) => `hashed:${k}`),
    hashEnrollmentKeyCandidates: vi.fn((k: string) => [`hashed:${k}`]),
    // Real implementation, not a stub: the secret-comparison branches assert
    // on actual digests, and stubbing would make the invalid-secret denials
    // vacuous.
    hashEnrollmentSecret: vi.fn((s: string) => sha('sha256').update(s).digest('hex')),
  };
});

// Partial mock: only the IP SOURCE is stubbed. rateLimitIpKey (the IPv6 /64
// bucket folding used to build limiter keys) is kept REAL so the test exercises
// the same key the production path produces.
vi.mock('../../services/clientIp', async (importOriginal) => ({
  rateLimitIpKey: (await importOriginal<typeof import('../../services/clientIp')>()).rateLimitIpKey,
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
  queueWarrantySyncForDevice: vi.fn(async () => undefined),
}));

vi.mock('../../services/ipClassify', () => ({
  enqueueIpClassify: vi.fn(async () => undefined),
}));

vi.mock('../../services/partnerHooks', () => ({
  dispatchHook: vi.fn(async () => undefined),
}));

vi.mock('../../services/tenantStatus', () => ({
  getActiveOrgTenant: vi.fn(async () => ({ orgId: 'org-active', partnerId: 'partner-active' })),
}));

vi.mock('../../services/deviceIdentityCollisionAlert', () => ({
  raiseDeviceIdentityCollisionAlert: vi.fn(async () => 'alert-1'),
}));

vi.mock('../../config/partnerTrustMode', () => ({
  partnerTrustMode: vi.fn(() => 'off'),
}));

vi.mock('../../services/partnerTrust', () => ({
  evaluateCapability: vi.fn(async () => ({ allow: true })),
  unresolvedPartnerDecision: vi.fn(async () => ({ allow: true })),
  trustDenyBody: vi.fn((decision: Record<string, unknown>, reviewRequested: boolean) => ({
    error: decision.code,
    capability: decision.capability,
    reason: decision.reason,
    reviewRequested,
    meetingUrl: null,
  })),
}));

// ---------- imports after mocks ----------

import { db, withSystemDbAccessContext } from '../../db';
import { writeAuditEvent } from '../../services/auditEvents';
import { recordAgentEnrollment } from '../../services/anomalyMetrics';
import { getActiveOrgTenant } from '../../services/tenantStatus';
import * as manifestSigning from '../../services/manifestSigning';
import { getTrustedClientIp } from '../../services/clientIp';
import { queueWarrantySyncForDevice } from '../../services/warrantyWorker';
import { enqueueIpClassify } from '../../services/ipClassify';
import { raiseDeviceIdentityCollisionAlert } from '../../services/deviceIdentityCollisionAlert';
import { partnerTrustMode } from '../../config/partnerTrustMode';
import { evaluateCapability, unresolvedPartnerDecision } from '../../services/partnerTrust';
import {
  devices as devicesTable,
  enrollmentKeys as enrollmentKeysTable,
  partners as partnersTable,
  supportSessions as supportSessionsTable,
} from '../../db/schema';
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

// The org/partner lookups end in `.limit(1)`; the colliding-device lookup
// (#2764) fetches EVERY match and ends in `.orderBy(devices.createdAt)`. One
// thenable that answers to both shapes keeps every call site identical.
function rowsResult(rows: Record<string, unknown>[]): any {
  return Object.assign(Promise.resolve(rows), {
    limit: vi.fn().mockResolvedValue(rows),
    orderBy: vi.fn().mockResolvedValue(rows),
  });
}

function mockSelectRows(rows: Record<string, unknown>[]) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn(() => ({
      where: vi.fn(() => rowsResult(rows)),
    })),
  } as any);
}

interface TxSpy {
  update: Mock<(table: unknown) => void>;
  insert: Mock<(table: unknown) => void>;
  /** values() passed to tx.insert(devices) — asserts the fresh-row payload. */
  deviceInsertValues: Record<string, unknown>[];
  /** Tables passed to tx.update(...) — used to prove the OLD row is untouched. */
  updatedTables: unknown[];
  /** set() payloads passed to tx.update(devices) — asserts in-place re-enrollment. */
  deviceUpdateValues: Record<string, unknown>[];
}

/**
 * Installs a db.transaction mock that records every table handed to
 * tx.update()/tx.insert() and returns `insertedDevice` from the first
 * tx.insert(devices).values().returning().
 */
function mockTransaction(insertedDevice: Record<string, unknown>, keyId = 'key-x'): TxSpy {
  const spy: TxSpy = {
    update: vi.fn(),
    insert: vi.fn(),
    deviceInsertValues: [],
    updatedTables: [],
    deviceUpdateValues: [],
  };

  vi.mocked(db.transaction).mockImplementation(async (fn: any) => {
    const fakeTx = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ count: 0 }]),
        }),
      }),
      update: vi.fn((table: unknown) => {
        spy.update(table);
        spy.updatedTables.push(table);
        // The in-place re-enroll UPDATE(devices) returns the device row; the
        // enrollment-key consume returns the claimed key id.
        const returned = table === devicesTable ? insertedDevice : { id: keyId };
        return {
          set: vi.fn((values: Record<string, unknown>) => {
            if (table === devicesTable) spy.deviceUpdateValues.push(values);
            return {
              where: vi.fn(() => Object.assign(
                Promise.resolve(undefined) as any,
                { returning: vi.fn().mockResolvedValue([returned]) },
              )),
            };
          }),
        };
      }),
      insert: vi.fn((table: unknown) => {
        spy.insert(table);
        return {
          values: vi.fn((values: Record<string, unknown>) => {
            if (table === devicesTable) spy.deviceInsertValues.push(values);
            return {
              returning: vi.fn().mockResolvedValue([insertedDevice]),
              onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
            };
          }),
        };
      }),
      delete: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    };
    return fn(fakeTx);
  });

  return spy;
}

async function enrollOk(): Promise<Record<string, unknown>> {
  vi.mocked(manifestSigning.getActiveTrustKeyset).mockResolvedValue([]);
  vi.mocked(manifestSigning.getActiveManifestKeyDelegations).mockResolvedValue([]);
  mockKeyLookup({
    id: 'key-backup-url',
    orgId: 'org-backup-url',
    siteId: 'site-backup-url',
    keySecretHash: null,
    expiresAt: new Date(Date.now() + 3600_000),
    maxUsage: 10,
    usageCount: 0,
  });
  mockSelectRows([{ partnerId: 'partner-backup-url' }]);
  mockSelectRows([{ maxDevices: null }]);
  mockSelectRows([]);

  vi.mocked(db.transaction).mockImplementation(async (fn: any) => {
    const fakeTx = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ count: 0 }]),
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{
            id: 'device-backup-url',
            orgId: 'org-backup-url',
            siteId: 'site-backup-url',
            hostname: 'host-1',
          }]),
          onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
        }),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: 'key-backup-url' }]),
          }),
        }),
      }),
      delete: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    };
    return fn(fakeTx);
  });

  const resp = await buildApp().request('/agents/enroll', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(baseEnrollBody),
  });
  expect(resp.status).toBe(201);
  return await resp.json() as Record<string, unknown>;
}

// ---------- tests ----------

describe('POST /agents/enroll — backup server URL delivery (#2288)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.AGENT_ENROLLMENT_SECRET;
    delete process.env.AGENT_BACKUP_SERVER_URL;
    process.env.NODE_ENV = 'test';
  });

  it('includes backupServerUrl when AGENT_BACKUP_SERVER_URL is set', async () => {
    process.env.AGENT_BACKUP_SERVER_URL = 'https://new.example.com';
    const body = await enrollOk();
    expect(body.backupServerUrl).toBe('https://new.example.com');
  });

  it('omits/empty backupServerUrl when env unset', async () => {
    const body = await enrollOk();
    expect(body.backupServerUrl ?? '').toBe('');
  });
});

describe('POST /agents/enroll — partner trust probation enrollment counter (Task 4.4)', () => {
  function arrangeEnrollment() {
    mockKeyLookup({
      id: 'key-trust',
      orgId: 'org-trust',
      siteId: 'site-trust',
      keySecretHash: null,
      expiresAt: new Date(Date.now() + 3600_000),
      maxUsage: null,
      usageCount: 0,
      supportSessionId: null,
    });
    mockSelectRows([{ partnerId: 'partner-trust' }]);
    mockSelectRows([{ maxDevices: null }]);
    mockSelectRows([]);
  }

  function installTrustTransaction(trustRow: {
    trustState: 'probation' | 'trusted';
    probationEnrollments: number;
  } | null) {
    const forUpdate = vi.fn().mockResolvedValue(trustRow ? [trustRow] : []);
    const select = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ for: forUpdate }),
      }),
    });
    const insertedDevice = {
      id: 'device-trust',
      orgId: 'org-trust',
      siteId: 'site-trust',
      hostname: 'host-1',
    };
    const insertedTables: unknown[] = [];
    const updateCalls: Array<{ table: unknown; values: Record<string, unknown> }> = [];

    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn({
      select,
      update: vi.fn((table: unknown) => ({
        set: vi.fn((values: Record<string, unknown>) => {
          updateCalls.push({ table, values });
          const returning = table === enrollmentKeysTable
            ? vi.fn().mockResolvedValue([{ id: 'key-trust' }])
            : vi.fn().mockResolvedValue([]);
          return {
            where: vi.fn(() => Object.assign(Promise.resolve(undefined), { returning })),
          };
        }),
      })),
      insert: vi.fn((table: unknown) => {
        insertedTables.push(table);
        return {
          values: vi.fn(() => ({
            returning: vi.fn().mockResolvedValue([insertedDevice]),
            onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
          })),
        };
      }),
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    }));

    return { forUpdate, select, insertedTables, updateCalls };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.AGENT_ENROLLMENT_SECRET;
    process.env.NODE_ENV = 'test';
    vi.mocked(partnerTrustMode).mockReturnValue('enforce');
    vi.mocked(evaluateCapability).mockResolvedValue({ allow: true });
  });

  afterEach(() => {
    vi.mocked(partnerTrustMode).mockReturnValue('off');
  });

  it('denies the sixth probation enrollment with the trust contract and no device insert', async () => {
    arrangeEnrollment();
    const tx = installTrustTransaction({ trustState: 'probation', probationEnrollments: 5 });
    vi.mocked(evaluateCapability).mockResolvedValue({
      allow: false,
      code: 'TRUST_PROBATION',
      capability: 'agent_enroll',
      reason: 'probation_enrollment_cap',
    });

    const resp = await buildApp().request('/agents/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseEnrollBody),
    });

    expect(resp.status).toBe(403);
    expect(await resp.json()).toEqual({
      error: 'TRUST_PROBATION',
      capability: 'agent_enroll',
      reason: 'probation_enrollment_cap',
      reviewRequested: false,
      meetingUrl: null,
    });
    expect(tx.forUpdate).toHaveBeenCalledWith('update');
    expect(evaluateCapability).toHaveBeenCalledWith('agent_enroll', {
      partnerId: 'partner-trust',
      orgId: 'org-trust',
      detail: { probationEnrollments: 5 },
    });
    expect(tx.insertedTables).not.toContain(devicesTable);
    expect(writeAuditEvent).toHaveBeenCalledWith(expect.anything(), {
      orgId: 'org-trust',
      action: 'agent.enroll',
      resourceType: 'device',
      result: 'denied',
      details: { reason: 'probation_enrollment_cap' },
    });
  });

  it('serializes and increments the fifth probation enrollment before inserting the device', async () => {
    arrangeEnrollment();
    const tx = installTrustTransaction({ trustState: 'probation', probationEnrollments: 4 });

    const resp = await buildApp().request('/agents/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseEnrollBody),
    });

    expect(resp.status).toBe(201);
    expect(tx.insertedTables).toContain(devicesTable);
    const partnerUpdate = tx.updateCalls.find((call) => call.table === partnersTable);
    expect(partnerUpdate).toBeDefined();
    expect(JSON.stringify(partnerUpdate?.values.probationEnrollments)).toContain('+ 1');
  });

  it('locks but does not increment a trusted partner', async () => {
    arrangeEnrollment();
    const tx = installTrustTransaction({ trustState: 'trusted', probationEnrollments: 5 });

    const resp = await buildApp().request('/agents/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseEnrollBody),
    });

    expect(resp.status).toBe(201);
    expect(tx.forUpdate).toHaveBeenCalledWith('update');
    expect(evaluateCapability).not.toHaveBeenCalled();
    expect(tx.updateCalls.some((call) => call.table === partnersTable)).toBe(false);
  });

  it('does not issue the partner SELECT FOR UPDATE when trust mode is off', async () => {
    vi.mocked(partnerTrustMode).mockReturnValue('off');
    arrangeEnrollment();
    const tx = installTrustTransaction({ trustState: 'probation', probationEnrollments: 5 });

    const resp = await buildApp().request('/agents/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseEnrollBody),
    });

    expect(resp.status).toBe(201);
    expect(tx.select).not.toHaveBeenCalled();
    expect(tx.forUpdate).not.toHaveBeenCalled();
    expect(evaluateCapability).not.toHaveBeenCalled();
  });

  it('denies with the trust contract and no device insert when the partner row cannot be resolved under enforce', async () => {
    arrangeEnrollment();
    const tx = installTrustTransaction(null);
    vi.mocked(unresolvedPartnerDecision).mockResolvedValueOnce({
      allow: false,
      code: 'TRUST_RESTRICTED',
      capability: 'agent_enroll',
      reason: 'partner_unresolved',
    });

    const resp = await buildApp().request('/agents/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseEnrollBody),
    });

    expect(resp.status).toBe(403);
    expect(await resp.json()).toEqual({
      error: 'TRUST_RESTRICTED',
      capability: 'agent_enroll',
      reason: 'partner_unresolved',
      reviewRequested: false,
      meetingUrl: null,
    });
    expect(unresolvedPartnerDecision).toHaveBeenCalledWith('agent_enroll');
    expect(evaluateCapability).not.toHaveBeenCalled();
    expect(tx.insertedTables).not.toContain(devicesTable);
    expect(writeAuditEvent).toHaveBeenCalledWith(expect.anything(), {
      orgId: 'org-trust',
      action: 'agent.enroll',
      resourceType: 'device',
      result: 'denied',
      details: { reason: 'partner_unresolved' },
    });
  });

  it('inserts the device under shadow when the partner row cannot be resolved', async () => {
    arrangeEnrollment();
    const tx = installTrustTransaction(null);
    vi.mocked(unresolvedPartnerDecision).mockResolvedValueOnce({ allow: true });

    const resp = await buildApp().request('/agents/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseEnrollBody),
    });

    expect(resp.status).toBe(201);
    expect(unresolvedPartnerDecision).toHaveBeenCalledWith('agent_enroll');
    expect(tx.insertedTables).toContain(devicesTable);
  });
});

describe('POST /agents/enroll — tenant-status gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.AGENT_ENROLLMENT_SECRET;
    process.env.NODE_ENV = 'test';
    vi.mocked(getActiveOrgTenant).mockResolvedValue({ orgId: 'org-active', partnerId: 'partner-active' });
  });

  it('rejects with 403 tenant_inactive when the enrollment key tenant is suspended/deleted', async () => {
    mockKeyLookup({
      id: 'key-9',
      orgId: 'org-9',
      siteId: 'site-9',
      keySecretHash: null,
      expiresAt: new Date(Date.now() + 3600_000),
      maxUsage: 10,
      usageCount: 0,
    });
    vi.mocked(getActiveOrgTenant).mockResolvedValueOnce(null);

    const resp = await buildApp().request('/agents/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseEnrollBody),
    });

    expect(resp.status).toBe(403);
    const body = await resp.json();
    expect(body.reason).toBe('tenant_inactive');
    expect(getActiveOrgTenant).toHaveBeenCalledWith('org-9');
    // The denial audit is the forensic trail for a suspended-for-abuse tenant
    // attempting re-enrollment — assert its shape, not just that it fired.
    expect(writeAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'agent.enroll',
        result: 'denied',
        details: expect.objectContaining({ reason: 'tenant_inactive', enrollmentKeyId: 'key-9' }),
      }),
    );
  });
});

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
    // Valid lookup → the in-transaction claim UPDATE affects 0 rows → race-lost branch.
    // #946: the increment used to live outside the transaction; it is now the
    // last statement inside it, so we simulate the race by having the
    // transaction's tx.update().returning() return [].
    mockKeyLookup({
      id: 'key-3',
      orgId: 'org-3',
      siteId: 'site-3',
      keySecretHash: null,
      expiresAt: new Date(Date.now() + 3600_000),
      maxUsage: 10,
      usageCount: 0,
    });

    mockSelectRows([{ partnerId: 'partner-3' }]);
    mockSelectRows([{ maxDevices: null }]);
    mockSelectRows([]); // no existing device

    // Inside the transaction: device INSERT succeeds, then the consume-key
    // UPDATE returns [] (race-lost). The route throws the sentinel and the
    // transaction rolls back; outer catch surfaces the 401.
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => {
      const fakeTx = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 0 }]),
          }),
        }),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{
              id: 'device-race-lost',
              orgId: 'org-3',
              siteId: 'site-3',
              hostname: 'host-1',
            }]),
            onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
          }),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
        delete: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      };
      return fn(fakeTx);
    });

    const resp = await buildApp().request('/agents/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseEnrollBody),
    });

    expect(resp.status).toBe(401);
    const body = await resp.json();
    expect(body.reason).toBe('enrollment_key_race_lost');
  });

  // ---- #2764: hostname collision enrolls a FRESH row instead of 409 ----
  //
  // Matrix row 5 (active/offline existing row, no/invalid token): the machine
  // structurally cannot hold the prior row's token after a reimage or a
  // credential-losing uninstall, so the old 409 made the host permanently
  // un-enrollable and rolled back the whole MSI install. Prevention value was
  // near-nil anyway (hostname is self-attested). Replaced by DETECTION:
  // fresh row + possibleReplacementOfDeviceId linkage + audit + operator alert.
  //
  // The invariant that makes this safe: enrollment NEVER writes to an existing
  // device row. Every test below asserts tx.update() was never handed the
  // devices table.

  it('enrolls a fresh device row (201) on hostname collision when the existing device token is absent and hardware identity conflicts', async () => {
    mockKeyLookup({
      id: 'key-4',
      orgId: 'org-4',
      siteId: 'site-4',
      keySecretHash: null,
      expiresAt: new Date(Date.now() + 3600_000),
      maxUsage: 10,
      usageCount: 0,
    });

    mockSelectRows([{ partnerId: 'partner-4' }]);
    mockSelectRows([{ maxDevices: null }]);
    mockSelectRows([{
      id: 'device-existing',
      status: 'online',
      agentTokenHash: 'existing-token-hash',
      previousTokenHash: null,
      previousTokenExpiresAt: null,
      agentTokenSuspendedAt: null,
    }]);

    const tx = mockTransaction({
      id: 'device-collision-fresh',
      orgId: 'org-4',
      siteId: 'site-4',
      hostname: 'host-1',
    }, 'key-4');

    const resp = await buildApp().request('/agents/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...baseEnrollBody,
        hardwareInfo: { serialNumber: 'SERIAL-ATTACKER' },
        networkInfo: [{ name: 'eth0', mac: '66:77:88:99:aa:bb' }],
      }),
    });

    expect(resp.status).toBe(201);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.deviceId).toBe('device-collision-fresh');
    expect(body.deviceId).not.toBe('device-existing');

    // (b) the fresh row carries the replacement linkage
    expect(tx.deviceInsertValues).toHaveLength(1);
    expect(tx.deviceInsertValues[0]).toMatchObject({
      hostname: 'host-1',
      possibleReplacementOfDeviceId: 'device-existing',
    });

    // (a) the OLD row is never written — no rename, no update, nothing.
    expect(tx.updatedTables).not.toContain(devicesTable);
    expect(db.update).not.toHaveBeenCalled();

    // (c) success audit carries the reason + full colliding-id list
    expect(writeAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'agent.enroll',
        resourceId: 'device-collision-fresh',
        details: expect.objectContaining({
          reason: 'hostname_collision_enrolled_fresh_row',
          possibleReplacementOfDeviceId: 'device-existing',
          collidingDeviceIds: ['device-existing'],
        }),
      }),
    );

    // The removed 409's denied audit must be gone entirely.
    expect(writeAuditEvent).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        details: expect.objectContaining({
          reason: 'hostname_collision_requires_existing_device_token',
        }),
      }),
    );
  });

  it('enrolls a fresh row on collision even when self-attested hardware identity matches (hardware never gates the branch)', async () => {
    mockKeyLookup({
      id: 'key-5',
      orgId: 'org-5',
      siteId: 'site-5',
      keySecretHash: null,
      expiresAt: new Date(Date.now() + 3600_000),
      maxUsage: 10,
      usageCount: 0,
    });

    mockSelectRows([{ partnerId: 'partner-5' }]);
    mockSelectRows([{ maxDevices: null }]);
    mockSelectRows([{
      id: 'device-existing',
      status: 'online',
      agentTokenHash: 'existing-token-hash',
      previousTokenHash: null,
      previousTokenExpiresAt: null,
      agentTokenSuspendedAt: null,
    }]);

    const tx = mockTransaction({
      id: 'device-hw-match-fresh',
      orgId: 'org-5',
      siteId: 'site-5',
      hostname: 'host-1',
    }, 'key-5');

    const resp = await buildApp().request('/agents/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...baseEnrollBody,
        hardwareInfo: { serialNumber: 'SERIAL-EXISTING' },
        networkInfo: [{ name: 'eth0', mac: '00:11:22:33:44:55' }],
      }),
    });

    expect(resp.status).toBe(201);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.deviceId).toBe('device-hw-match-fresh');
    expect(tx.updatedTables).not.toContain(devicesTable);
  });

  it('raises the identity-collision alert only when the colliding row is currently online', async () => {
    mockKeyLookup({
      id: 'key-alert-on',
      orgId: 'org-alert-on',
      siteId: 'site-alert-on',
      keySecretHash: null,
      expiresAt: new Date(Date.now() + 3600_000),
      maxUsage: 10,
      usageCount: 0,
    });

    mockSelectRows([{ partnerId: 'partner-alert-on' }]);
    mockSelectRows([{ maxDevices: null }]);
    mockSelectRows([{
      id: 'device-online-collider',
      status: 'online',
      agentTokenHash: 'not-ours',
      previousTokenHash: null,
      previousTokenExpiresAt: null,
      agentTokenSuspendedAt: null,
    }]);

    mockTransaction({
      id: 'device-alert-fresh',
      orgId: 'org-alert-on',
      siteId: 'site-alert-on',
      hostname: 'host-1',
    }, 'key-alert-on');

    const resp = await buildApp().request('/agents/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseEnrollBody),
    });

    expect(resp.status).toBe(201);
    expect(raiseDeviceIdentityCollisionAlert).toHaveBeenCalledWith({
      orgId: 'org-alert-on',
      siteId: 'site-alert-on',
      hostname: 'host-1',
      newDeviceId: 'device-alert-fresh',
      existingDeviceId: 'device-online-collider',
      collidingDeviceIds: ['device-online-collider'],
    });
  });

  it('does not raise the identity-collision alert when the colliding row is offline (stale row, not a lookalike)', async () => {
    mockKeyLookup({
      id: 'key-alert-off',
      orgId: 'org-alert-off',
      siteId: 'site-alert-off',
      keySecretHash: null,
      expiresAt: new Date(Date.now() + 3600_000),
      maxUsage: 10,
      usageCount: 0,
    });

    mockSelectRows([{ partnerId: 'partner-alert-off' }]);
    mockSelectRows([{ maxDevices: null }]);
    mockSelectRows([{
      id: 'device-offline-collider',
      status: 'offline',
      agentTokenHash: 'not-ours',
      previousTokenHash: null,
      previousTokenExpiresAt: null,
      agentTokenSuspendedAt: null,
    }]);

    mockTransaction({
      id: 'device-alert-off-fresh',
      orgId: 'org-alert-off',
      siteId: 'site-alert-off',
      hostname: 'host-1',
    }, 'key-alert-off');

    const resp = await buildApp().request('/agents/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseEnrollBody),
    });

    expect(resp.status).toBe(201);
    expect(raiseDeviceIdentityCollisionAlert).not.toHaveBeenCalled();
  });

  it('an alert failure never fails the enrollment (best-effort)', async () => {
    vi.mocked(raiseDeviceIdentityCollisionAlert).mockRejectedValueOnce(new Error('alerting down'));

    mockKeyLookup({
      id: 'key-alert-fail',
      orgId: 'org-alert-fail',
      siteId: 'site-alert-fail',
      keySecretHash: null,
      expiresAt: new Date(Date.now() + 3600_000),
      maxUsage: 10,
      usageCount: 0,
    });

    mockSelectRows([{ partnerId: 'partner-alert-fail' }]);
    mockSelectRows([{ maxDevices: null }]);
    mockSelectRows([{
      id: 'device-collider',
      status: 'online',
      agentTokenHash: 'not-ours',
      previousTokenHash: null,
      previousTokenExpiresAt: null,
      agentTokenSuspendedAt: null,
    }]);

    mockTransaction({
      id: 'device-alert-fail-fresh',
      orgId: 'org-alert-fail',
      siteId: 'site-alert-fail',
      hostname: 'host-1',
    }, 'key-alert-fail');

    const resp = await buildApp().request('/agents/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseEnrollBody),
    });

    expect(resp.status).toBe(201);
  });

  it('links the FIRST ONLINE colliding row and audits every colliding id', async () => {
    mockKeyLookup({
      id: 'key-multi',
      orgId: 'org-multi',
      siteId: 'site-multi',
      keySecretHash: null,
      expiresAt: new Date(Date.now() + 3600_000),
      maxUsage: 10,
      usageCount: 0,
    });

    mockSelectRows([{ partnerId: 'partner-multi' }]);
    mockSelectRows([{ maxDevices: null }]);
    // Oldest-first. The oldest is offline; the online one is the live
    // lookalike the operator needs pointed at.
    mockSelectRows([
      {
        id: 'device-old-offline',
        status: 'offline',
        agentTokenHash: 'hash-a',
        previousTokenHash: null,
        previousTokenExpiresAt: null,
        agentTokenSuspendedAt: null,
      },
      {
        id: 'device-newer-online',
        status: 'online',
        agentTokenHash: 'hash-b',
        previousTokenHash: null,
        previousTokenExpiresAt: null,
        agentTokenSuspendedAt: null,
      },
    ]);

    const tx = mockTransaction({
      id: 'device-multi-fresh',
      orgId: 'org-multi',
      siteId: 'site-multi',
      hostname: 'host-1',
    }, 'key-multi');

    const resp = await buildApp().request('/agents/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseEnrollBody),
    });

    expect(resp.status).toBe(201);
    expect(tx.deviceInsertValues[0]).toMatchObject({
      possibleReplacementOfDeviceId: 'device-newer-online',
    });
    expect(writeAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        resourceId: 'device-multi-fresh',
        details: expect.objectContaining({
          reason: 'hostname_collision_enrolled_fresh_row',
          possibleReplacementOfDeviceId: 'device-newer-online',
          collidingDeviceIds: ['device-old-offline', 'device-newer-online'],
        }),
      }),
    );
    expect(raiseDeviceIdentityCollisionAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        existingDeviceId: 'device-newer-online',
        collidingDeviceIds: ['device-old-offline', 'device-newer-online'],
      }),
    );
  });

  it('matrix row 6: a suspended token on an ACTIVE row does not block a fresh enrollment', async () => {
    // Suspension binds the OLD row's credential; it is not a claim over the
    // hostname. Only the decommissioned+suspended combination stays a refusal
    // (deliberate ops alarm — pinned separately below).
    mockKeyLookup({
      id: 'key-susp-active',
      orgId: 'org-susp-active',
      siteId: 'site-susp-active',
      keySecretHash: null,
      expiresAt: new Date(Date.now() + 3600_000),
      maxUsage: 10,
      usageCount: 0,
    });

    mockSelectRows([{ partnerId: 'partner-susp-active' }]);
    mockSelectRows([{ maxDevices: null }]);
    mockSelectRows([{
      id: 'device-susp-active',
      status: 'online',
      agentTokenHash: 'old-hash',
      previousTokenHash: null,
      previousTokenExpiresAt: null,
      agentTokenSuspendedAt: new Date('2026-05-25T12:00:00Z'),
    }]);

    const tx = mockTransaction({
      id: 'device-susp-active-fresh',
      orgId: 'org-susp-active',
      siteId: 'site-susp-active',
      hostname: 'host-1',
    }, 'key-susp-active');

    const resp = await buildApp().request('/agents/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseEnrollBody),
    });

    expect(resp.status).toBe(201);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.deviceId).toBe('device-susp-active-fresh');
    expect(tx.deviceInsertValues[0]).toMatchObject({
      possibleReplacementOfDeviceId: 'device-susp-active',
    });
    expect(tx.updatedTables).not.toContain(devicesTable);
    expect(writeAuditEvent).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        details: expect.objectContaining({
          reason: 'existing_decommissioned_row_has_suspended_token',
        }),
      }),
    );
  });

  it('matrix row 4: a valid existing-device token still re-enrolls the SAME row in place (no fresh row)', async () => {
    const validToken = 'valid-reenroll-token';
    const validHash = createHash('sha256').update(validToken).digest('hex');

    mockKeyLookup({
      id: 'key-inplace',
      orgId: 'org-inplace',
      siteId: 'site-inplace',
      keySecretHash: null,
      expiresAt: new Date(Date.now() + 3600_000),
      maxUsage: 10,
      usageCount: 0,
    });

    mockSelectRows([{ partnerId: 'partner-inplace' }]);
    mockSelectRows([{ maxDevices: null }]);
    mockSelectRows([{
      id: 'device-inplace',
      status: 'offline',
      agentTokenHash: validHash,
      previousTokenHash: null,
      previousTokenExpiresAt: null,
      agentTokenSuspendedAt: null,
    }]);

    const tx = mockTransaction({
      id: 'device-inplace',
      orgId: 'org-inplace',
      siteId: 'site-inplace',
      hostname: 'host-1',
    }, 'key-inplace');

    const resp = await buildApp().request('/agents/enroll', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-agent-reenrollment-token': validToken,
      },
      body: JSON.stringify(baseEnrollBody),
    });

    expect(resp.status).toBe(201);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.deviceId).toBe('device-inplace');
    // In-place re-enroll: the devices UPDATE is the known, allowed write.
    expect(tx.updatedTables).toContain(devicesTable);
    expect(tx.deviceInsertValues).toHaveLength(0);
    expect(tx.deviceUpdateValues).toHaveLength(1);
    expect(tx.deviceUpdateValues[0]).toMatchObject({ status: 'pending' });
    expect(tx.deviceUpdateValues[0]).not.toHaveProperty('lastSeenAt');
    expect(raiseDeviceIdentityCollisionAlert).not.toHaveBeenCalled();
  });

  it('idempotency: a token matching a LATER colliding row re-enrolls that row instead of stacking another fresh row', async () => {
    // Without matching the presented credential against every colliding row,
    // each reinstall would mint yet another row (row 1 checked, no match,
    // fresh row) — an unbounded device-row leak on the very path this
    // feature exists to make idempotent.
    const validToken = 'second-row-token';
    const validHash = createHash('sha256').update(validToken).digest('hex');

    mockKeyLookup({
      id: 'key-stack',
      orgId: 'org-stack',
      siteId: 'site-stack',
      keySecretHash: null,
      expiresAt: new Date(Date.now() + 3600_000),
      maxUsage: 10,
      usageCount: 0,
    });

    mockSelectRows([{ partnerId: 'partner-stack' }]);
    mockSelectRows([{ maxDevices: null }]);
    mockSelectRows([
      {
        id: 'device-stale-first',
        status: 'online',
        agentTokenHash: 'someone-elses',
        previousTokenHash: null,
        previousTokenExpiresAt: null,
        agentTokenSuspendedAt: null,
      },
      {
        id: 'device-ours-second',
        status: 'offline',
        agentTokenHash: validHash,
        previousTokenHash: null,
        previousTokenExpiresAt: null,
        agentTokenSuspendedAt: null,
      },
    ]);

    const tx = mockTransaction({
      id: 'device-ours-second',
      orgId: 'org-stack',
      siteId: 'site-stack',
      hostname: 'host-1',
    }, 'key-stack');

    const resp = await buildApp().request('/agents/enroll', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-agent-reenrollment-token': validToken,
      },
      body: JSON.stringify(baseEnrollBody),
    });

    expect(resp.status).toBe(201);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.deviceId).toBe('device-ours-second');
    expect(tx.deviceInsertValues).toHaveLength(0);
  });

  it('a DECOMMISSIONED collider never shadows a live one: collision path fires, not decom-bypass', async () => {
    // Sequence that made this reachable: a collision minted row2; the operator
    // then decommissioned row1; row2's machine reinstalls with no token. The
    // oldest collider is row1 (decommissioned), but the enrollment is plainly
    // a replacement of the LIVE row2 — taking the decom bypass here would skip
    // linkage, the collision audit and the alert entirely.
    mockKeyLookup({
      id: 'key-decom-shadow',
      orgId: 'org-decom-shadow',
      siteId: 'site-decom-shadow',
      keySecretHash: null,
      expiresAt: new Date(Date.now() + 3600_000),
      maxUsage: 10,
      usageCount: 0,
    });

    mockSelectRows([{ partnerId: 'partner-decom-shadow' }]);
    mockSelectRows([{ maxDevices: null }]);
    mockSelectRows([
      {
        id: 'device-decommissioned-oldest',
        status: 'decommissioned',
        agentTokenHash: 'dead-hash',
        previousTokenHash: null,
        previousTokenExpiresAt: null,
        agentTokenSuspendedAt: null,
      },
      {
        id: 'device-live-offline',
        status: 'offline',
        agentTokenHash: 'live-hash',
        previousTokenHash: null,
        previousTokenExpiresAt: null,
        agentTokenSuspendedAt: null,
      },
    ]);

    const tx = mockTransaction({
      id: 'device-decom-shadow-fresh',
      orgId: 'org-decom-shadow',
      siteId: 'site-decom-shadow',
      hostname: 'host-1',
    }, 'key-decom-shadow');

    const resp = await buildApp().request('/agents/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseEnrollBody),
    });

    expect(resp.status).toBe(201);
    // Linked to the LIVE row, not the decommissioned one.
    expect(tx.deviceInsertValues[0]).toMatchObject({
      possibleReplacementOfDeviceId: 'device-live-offline',
    });
    // No decom-bypass: the prior row was NOT renamed.
    expect(tx.updatedTables).not.toContain(devicesTable);
    expect(writeAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        resourceId: 'device-decom-shadow-fresh',
        details: expect.objectContaining({
          reason: 'hostname_collision_enrolled_fresh_row',
          possibleReplacementOfDeviceId: 'device-live-offline',
          collidingDeviceIds: ['device-decommissioned-oldest', 'device-live-offline'],
        }),
      }),
    );
    expect(writeAuditEvent).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        details: expect.objectContaining({
          reason: 'decommissioned_row_reenrolled_fresh_id',
        }),
      }),
    );
  });

  it('a decommissioned+SUSPENDED collider alongside a live one does not resurrect the un-enrollable 409', async () => {
    // Same shape as above but the dead row also carries a probe suspension.
    // Selecting it would return `existing_decommissioned_row_has_suspended_token`
    // and make a perfectly healthy host permanently un-enrollable — precisely
    // the failure this whole change exists to remove. The 409 stays reachable
    // only when EVERY collider is decommissioned (pinned separately below).
    mockKeyLookup({
      id: 'key-decom-susp-shadow',
      orgId: 'org-decom-susp-shadow',
      siteId: 'site-decom-susp-shadow',
      keySecretHash: null,
      expiresAt: new Date(Date.now() + 3600_000),
      maxUsage: 10,
      usageCount: 0,
    });

    mockSelectRows([{ partnerId: 'partner-decom-susp-shadow' }]);
    mockSelectRows([{ maxDevices: null }]);
    mockSelectRows([
      {
        id: 'device-decom-suspended',
        status: 'decommissioned',
        agentTokenHash: 'dead-hash',
        previousTokenHash: null,
        previousTokenExpiresAt: null,
        agentTokenSuspendedAt: new Date('2026-05-25T12:00:00Z'),
      },
      {
        id: 'device-live-online',
        status: 'online',
        agentTokenHash: 'live-hash',
        previousTokenHash: null,
        previousTokenExpiresAt: null,
        agentTokenSuspendedAt: null,
      },
    ]);

    const tx = mockTransaction({
      id: 'device-decom-susp-fresh',
      orgId: 'org-decom-susp-shadow',
      siteId: 'site-decom-susp-shadow',
      hostname: 'host-1',
    }, 'key-decom-susp-shadow');

    const resp = await buildApp().request('/agents/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseEnrollBody),
    });

    expect(resp.status).toBe(201);
    expect(tx.deviceInsertValues[0]).toMatchObject({
      possibleReplacementOfDeviceId: 'device-live-online',
    });
    expect(writeAuditEvent).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        details: expect.objectContaining({
          reason: 'existing_decommissioned_row_has_suspended_token',
        }),
      }),
    );
  });

  it('an unauthenticated enrollment is refused when ANY collider is quarantined', async () => {
    // Containment must not be sidestepped by the collision path: without a
    // credential there is nothing distinguishing this agent from the
    // quarantined row itself, so any quarantined collider blocks.
    mockKeyLookup({
      id: 'key-q-multi',
      orgId: 'org-q-multi',
      siteId: 'site-q-multi',
      keySecretHash: null,
      expiresAt: new Date(Date.now() + 3600_000),
      maxUsage: 10,
      usageCount: 0,
    });

    mockSelectRows([{ partnerId: 'partner-q-multi' }]);
    mockSelectRows([{ maxDevices: null }]);
    mockSelectRows([
      {
        id: 'device-q-clean-oldest',
        status: 'offline',
        agentTokenHash: 'clean-hash',
        previousTokenHash: null,
        previousTokenExpiresAt: null,
        agentTokenSuspendedAt: null,
      },
      {
        id: 'device-q-quarantined',
        status: 'quarantined',
        agentTokenHash: 'quarantined-hash',
        previousTokenHash: null,
        previousTokenExpiresAt: null,
        agentTokenSuspendedAt: null,
      },
    ]);

    const resp = await buildApp().request('/agents/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseEnrollBody),
    });

    expect(resp.status).toBe(403);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.reason).toBe('device_quarantined');
    expect(writeAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        resourceId: 'device-q-quarantined',
        result: 'denied',
        details: expect.objectContaining({
          reason: 'quarantined_device_reenroll_refused',
        }),
      }),
    );
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('a quarantined SIBLING does not block an agent that authenticated to its own clean row', async () => {
    // The agent proved possession of a non-quarantined row's credential —
    // quarantine of some other row sharing the hostname is not a claim over
    // this device, and refusing here would break re-enrollment idempotency.
    const validToken = 'clean-row-token';
    const validHash = createHash('sha256').update(validToken).digest('hex');

    mockKeyLookup({
      id: 'key-q-sibling',
      orgId: 'org-q-sibling',
      siteId: 'site-q-sibling',
      keySecretHash: null,
      expiresAt: new Date(Date.now() + 3600_000),
      maxUsage: 10,
      usageCount: 0,
    });

    mockSelectRows([{ partnerId: 'partner-q-sibling' }]);
    mockSelectRows([{ maxDevices: null }]);
    mockSelectRows([
      {
        id: 'device-q-sibling-quarantined',
        status: 'quarantined',
        agentTokenHash: 'not-ours',
        previousTokenHash: null,
        previousTokenExpiresAt: null,
        agentTokenSuspendedAt: null,
      },
      {
        id: 'device-q-sibling-clean',
        status: 'offline',
        agentTokenHash: validHash,
        previousTokenHash: null,
        previousTokenExpiresAt: null,
        agentTokenSuspendedAt: null,
      },
    ]);

    const tx = mockTransaction({
      id: 'device-q-sibling-clean',
      orgId: 'org-q-sibling',
      siteId: 'site-q-sibling',
      hostname: 'host-1',
    }, 'key-q-sibling');

    const resp = await buildApp().request('/agents/enroll', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-agent-reenrollment-token': validToken,
      },
      body: JSON.stringify(baseEnrollBody),
    });

    expect(resp.status).toBe(201);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.deviceId).toBe('device-q-sibling-clean');
    // In-place re-enroll of the agent's own row; no fresh row minted.
    expect(tx.updatedTables).toContain(devicesTable);
    expect(tx.deviceInsertValues).toHaveLength(0);
    expect(writeAuditEvent).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        details: expect.objectContaining({
          reason: 'quarantined_device_reenroll_refused',
        }),
      }),
    );
  });

  it('allows re-enrollment without the existing-device token when the existing row is decommissioned (mints a fresh device.id — #914)', async () => {
    // Real-world scenario (Trevor-Legion, 2026-05-25):
    // 1. Admin calls DELETE /api/v1/devices/<id> — soft-deletes, status=decommissioned
    // 2. Operator uninstalls Breeze on the endpoint and re-runs the installer
    // 3. Fresh agent has no prior token; re-enrolls
    // Pre-fix: hostname-collision check returned 409 even for decommissioned
    // rows, leaving the host permanently un-enrollable without a hand-rename
    // in SQL.
    // Post-#896: re-enrollment succeeds but the new agent silently inherits
    // the prior row's device.id and audit history (issue #914 — anyone with
    // org enrollment key + secret + a known-decommissioned hostname could
    // adopt the prior identity).
    // Post-#914: re-enrollment succeeds with a FRESH device.id; the prior
    // row is renamed (hostname suffixed with `.decom-<id8>`) inside the
    // transaction and retains its FK-attached audit history.
    mockKeyLookup({
      id: 'key-decom',
      orgId: 'org-decom',
      siteId: 'site-decom',
      keySecretHash: null,
      expiresAt: new Date(Date.now() + 3600_000),
      maxUsage: 10,
      usageCount: 0,
    });

    // Claim the enrollment key
    vi.mocked(db.update).mockReturnValueOnce({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue([{
            id: 'key-decom',
            orgId: 'org-decom',
            siteId: 'site-decom',
          }]),
        })),
      })),
    } as any);

    mockSelectRows([{ partnerId: 'partner-decom' }]);
    mockSelectRows([{ maxDevices: null }]);
    // Existing row is DECOMMISSIONED — no token attached to the request
    mockSelectRows([{
      id: 'device-decom-existing',
      status: 'decommissioned',
      agentTokenHash: 'old-decom-hash',
      previousTokenHash: null,
      previousTokenExpiresAt: null,
    }]);

    // Note: post-#914 the unconditional auto-restore UPDATE (status->offline)
    // is SKIPPED on the decom-bypass-fresh-id path. The old row stays
    // decommissioned and only its hostname is rewritten inside the
    // transaction. So we no longer queue a top-level db.update() here.

    // Transaction: rename + INSERT-new + consume-key. The decom-bypass-fresh-id
    // path executes tx.update() to rename the old row's hostname, then
    // tx.insert().returning() to create a fresh row with a new id, then
    // tx.update(enrollmentKeys).set().where().returning() to consume the key
    // (#946 — increment moved into the transaction, last statement).
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => {
      const fakeTx = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 0 }]),
          }),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn(() => Object.assign(
              Promise.resolve(undefined) as any,
              { returning: vi.fn().mockResolvedValue([{ id: 'key-decom' }]) }
            )),
          }),
        }),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{
              id: 'device-decom-fresh-id',
              orgId: 'org-decom',
              siteId: 'site-decom',
              hostname: 'host-1',
            }]),
            onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
          }),
        }),
        delete: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      };
      return fn(fakeTx);
    });

    const resp = await buildApp().request('/agents/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseEnrollBody),
    });

    expect(resp.status).toBe(201);
    const body = (await resp.json()) as Record<string, unknown>;
    // #914: response carries the FRESH device.id, NOT the prior one.
    expect(body.deviceId).toBe('device-decom-fresh-id');
    expect(body.deviceId).not.toBe('device-decom-existing');
    // Importantly: no 409 audit event was written for hostname_collision
    expect(writeAuditEvent).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        details: expect.objectContaining({
          reason: 'hostname_collision_requires_existing_device_token',
        }),
      })
    );
    // Bypass-audit row records the fresh-id reason + priorDeviceId for
    // forensic linkage. resourceId on THIS audit row is the prior id.
    expect(writeAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'agent.enroll',
        resourceId: 'device-decom-existing',
        result: 'success',
        details: expect.objectContaining({
          reason: 'decommissioned_row_reenrolled_fresh_id',
          priorDeviceId: 'device-decom-existing',
        }),
      })
    );
    // Success-audit row references the NEW id and back-links to the prior.
    expect(writeAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorType: 'agent',
        action: 'agent.enroll',
        resourceId: 'device-decom-fresh-id',
        details: expect.objectContaining({
          reenrollment: true,
          decomBypassPriorDeviceId: 'device-decom-existing',
        }),
      })
    );
    // Defense against the pre-#914 behavior re-emerging: assert the legacy
    // reason string is NOT used and that the success audit does NOT use the
    // prior id as resourceId.
    expect(writeAuditEvent).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        details: expect.objectContaining({
          reason: 'decommissioned_row_reenrolled',
        }),
      })
    );
    expect(writeAuditEvent).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorType: 'agent',
        resourceId: 'device-decom-existing',
      })
    );
  });

  it('status=offline (not decommissioned) enrolls a fresh row WITHOUT touching or renaming the old one (unlike decom-bypass)', async () => {
    // The decom-bypass renames the prior row to free the hostname. The
    // collision path must NOT copy that: both rows keep the hostname and
    // coexist until a human decides via the review surface.
    mockKeyLookup({
      id: 'key-offline',
      orgId: 'org-offline',
      siteId: 'site-offline',
      keySecretHash: null,
      expiresAt: new Date(Date.now() + 3600_000),
      maxUsage: 10,
      usageCount: 0,
    });

    mockSelectRows([{ partnerId: 'partner-offline' }]);
    mockSelectRows([{ maxDevices: null }]);
    // Existing row is OFFLINE (the normal "device hasn't checked in" state),
    // NOT decommissioned — no token attached to request.
    mockSelectRows([{
      id: 'device-offline-existing',
      status: 'offline',
      agentTokenHash: 'old-offline-hash',
      previousTokenHash: null,
      previousTokenExpiresAt: null,
      agentTokenSuspendedAt: null,
    }]);

    const tx = mockTransaction({
      id: 'device-offline-fresh',
      orgId: 'org-offline',
      siteId: 'site-offline',
      hostname: 'host-1',
    }, 'key-offline');

    const resp = await buildApp().request('/agents/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseEnrollBody),
    });

    expect(resp.status).toBe(201);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.deviceId).toBe('device-offline-fresh');
    expect(tx.deviceInsertValues[0]).toMatchObject({
      hostname: 'host-1',
      possibleReplacementOfDeviceId: 'device-offline-existing',
    });
    // No rename, no update of any kind against devices.
    expect(tx.updatedTables).not.toContain(devicesTable);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('denies re-enrollment when the existing row is decommissioned AND its token was probe-suspended', async () => {
    // Suspension trumps decommission. Task 18 added auto-suspend-on-probe
    // (commit 2669ea43); the maintainer's explicit intent is that
    // unsuspending be manual — "the reconnect-loop on a single device is the
    // desired ops alarm signal." An admin DELETE of a probe-suspended device
    // must NOT auto-restore the slot. The operator has to clear
    // agent_token_suspended_at deliberately first, which leaves an audit
    // trail of the "yes, I cleared a security suspension" decision.
    //
    // Real-world sequence A: probe-storm suspended the token at t=0, ops
    // alarm fired (reconnect-loop), admin investigated, decided the box was
    // compromised/abandoned, and decommissioned it. Without this gate, the
    // hostname could silently re-enroll with fresh tokens after the
    // suspension alarm fired — defeating the security signal.
    mockKeyLookup({
      id: 'key-suspended-decom',
      orgId: 'org-suspended-decom',
      siteId: 'site-suspended-decom',
      keySecretHash: null,
      expiresAt: new Date(Date.now() + 3600_000),
      maxUsage: 10,
      usageCount: 0,
    });

    vi.mocked(db.update).mockReturnValueOnce({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue([{
            id: 'key-suspended-decom',
            orgId: 'org-suspended-decom',
            siteId: 'site-suspended-decom',
          }]),
        })),
      })),
    } as any);

    mockSelectRows([{ partnerId: 'partner-suspended-decom' }]);
    mockSelectRows([{ maxDevices: null }]);
    // Existing row: DECOMMISSIONED AND token-suspended.
    mockSelectRows([{
      id: 'device-suspended-decom',
      status: 'decommissioned',
      agentTokenHash: 'old-suspended-hash',
      previousTokenHash: null,
      previousTokenExpiresAt: null,
      agentTokenSuspendedAt: new Date('2026-05-25T12:00:00Z'),
    }]);

    const resp = await buildApp().request('/agents/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseEnrollBody),
    });

    expect(resp.status).toBe(409);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.reason).toBe('existing_decommissioned_row_has_suspended_token');
    // Audit row was written denying the attempt — not silently allowed.
    expect(writeAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'agent.enroll',
        resourceId: 'device-suspended-decom',
        result: 'denied',
        details: expect.objectContaining({
          reason: 'existing_decommissioned_row_has_suspended_token',
        }),
      })
    );
    // NOT the decom-bypass success audit (post-#914 reason string)
    expect(writeAuditEvent).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        details: expect.objectContaining({
          reason: 'decommissioned_row_reenrolled_fresh_id',
        }),
      })
    );
  });

  it('refuses re-enrollment of a quarantined device even with a valid existing-device token (containment escape)', async () => {
    // A quarantined device (mTLS expired-cert policy, or admin security
    // quarantine) must NOT be able to clear its own containment by
    // re-enrolling. Even presenting a VALID existing-device token,
    // re-enrollment must be refused — only the admin /approve endpoint may
    // clear quarantinedAt/quarantinedReason and return the device to service.
    // Without this guard the quarantined row (or anyone holding its brz_
    // token — exactly what quarantine is meant to contain) re-POSTs /enroll
    // and the in-place UPDATE flips status back to 'online', resuming
    // heartbeat/commands/remote-desktop with no operator approval.
    const validToken = 'valid-existing-device-token';
    const validHash = createHash('sha256').update(validToken).digest('hex');

    mockKeyLookup({
      id: 'key-quarantined',
      orgId: 'org-quarantined',
      siteId: 'site-quarantined',
      keySecretHash: null,
      expiresAt: new Date(Date.now() + 3600_000),
      maxUsage: 10,
      usageCount: 0,
    });

    vi.mocked(db.update).mockReturnValueOnce({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue([{
            id: 'key-quarantined',
            orgId: 'org-quarantined',
            siteId: 'site-quarantined',
          }]),
        })),
      })),
    } as any);

    mockSelectRows([{ partnerId: 'partner-quarantined' }]);
    mockSelectRows([{ maxDevices: null }]);
    // Existing row: QUARANTINED, token NOT suspended, with a matching token —
    // i.e. the device would otherwise authenticate and be flipped online.
    mockSelectRows([{
      id: 'device-quarantined',
      status: 'quarantined',
      agentTokenHash: validHash,
      previousTokenHash: null,
      previousTokenExpiresAt: null,
      agentTokenSuspendedAt: null,
    }]);

    const resp = await buildApp().request('/agents/enroll', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-agent-reenrollment-token': validToken,
      },
      body: JSON.stringify(baseEnrollBody),
    });

    expect(resp.status).toBe(403);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.reason).toBe('device_quarantined');
    // Refusal is audited, not silently allowed.
    expect(writeAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'agent.enroll',
        resourceId: 'device-quarantined',
        result: 'denied',
        details: expect.objectContaining({
          reason: 'quarantined_device_reenroll_refused',
        }),
      })
    );
  });
});

describe('POST /agents/enroll — resolved-key denials are org-attributable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.AGENT_ENROLLMENT_SECRET;
    process.env.NODE_ENV = 'test';
    vi.mocked(getActiveOrgTenant).mockResolvedValue({ orgId: 'org-active', partnerId: 'partner-active' });
  });

  it('attributes missing_enrollment_secret to the resolved key\'s org (not null)', async () => {
    mockKeyLookup({
      id: 'key-secret-1',
      orgId: 'org-secret-1',
      siteId: 'site-secret-1',
      keySecretHash: 'per-key-secret-hash',
      expiresAt: new Date(Date.now() + 3600_000),
      maxUsage: null,
      usageCount: 0,
    });

    const resp = await buildApp().request('/agents/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseEnrollBody),
    });

    expect(resp.status).toBe(403);
    expect(writeAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId: 'org-secret-1',
        result: 'denied',
        details: expect.objectContaining({ reason: 'missing_enrollment_secret', keyId: 'key-secret-1' }),
      }),
    );
  });

  it('attributes invalid_enrollment_secret to the resolved key\'s org (not null)', async () => {
    mockKeyLookup({
      id: 'key-secret-2',
      orgId: 'org-secret-2',
      siteId: 'site-secret-2',
      keySecretHash: createHash('sha256').update('the-real-secret').digest('hex'),
      expiresAt: new Date(Date.now() + 3600_000),
      maxUsage: null,
      usageCount: 0,
    });

    const resp = await buildApp().request('/agents/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...baseEnrollBody, enrollmentSecret: 'wrong-secret' }),
    });

    expect(resp.status).toBe(403);
    expect(writeAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId: 'org-secret-2',
        result: 'denied',
        details: expect.objectContaining({ reason: 'invalid_enrollment_secret', keyId: 'key-secret-2' }),
      }),
    );
  });

  it('audits device_limit_reached denials with the resolved org — otherwise this signal is invisible to the abuse-signals denied CTE', async () => {
    mockKeyLookup({
      id: 'key-limit-1',
      orgId: 'org-limit-1',
      siteId: 'site-limit-1',
      keySecretHash: null,
      expiresAt: new Date(Date.now() + 3600_000),
      maxUsage: null,
      usageCount: 0,
    });

    mockSelectRows([{ partnerId: 'partner-limit-1' }]);
    mockSelectRows([{ maxDevices: 2 }]);
    mockSelectRows([]); // no existing device

    vi.mocked(db.transaction).mockImplementation(async (fn: any) => {
      const fakeTx = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 2 }]), // at cap
          }),
        }),
        insert: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      };
      return fn(fakeTx);
    });

    const resp = await buildApp().request('/agents/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseEnrollBody),
    });

    expect(resp.status).toBe(403);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.code).toBe('DEVICE_LIMIT_REACHED');
    expect(writeAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId: 'org-limit-1',
        action: 'agent.enroll',
        result: 'denied',
        details: expect.objectContaining({
          reason: 'device_limit_reached',
          enrollmentKeyId: 'key-limit-1',
          partnerId: 'partner-limit-1',
          currentDevices: 2,
          maxDevices: 2,
        }),
      }),
    );
  });
});

describe('POST /agents/enroll — ENROLLMENT_SECRET_ENFORCEMENT_MODE', () => {
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.AGENT_ENROLLMENT_SECRET;
    delete process.env.ENROLLMENT_SECRET_ENFORCEMENT_MODE;
    process.env.NODE_ENV = 'production';
  });

  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    delete process.env.ENROLLMENT_SECRET_ENFORCEMENT_MODE;
  });

  it('blocks production enrollment with no secret when mode is unset (default enforce)', async () => {
    mockKeyLookup({
      id: 'key-mode-1',
      orgId: 'org-mode-1',
      siteId: 'site-mode-1',
      keySecretHash: null,
      expiresAt: new Date(Date.now() + 3600_000),
      maxUsage: null,
      usageCount: 0,
    });

    const resp = await buildApp().request('/agents/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseEnrollBody),
    });

    expect(resp.status).toBe(403);
    const body = await resp.json();
    expect(body.error).toMatch(/secret/i);
    expect(writeAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        details: { reason: 'no_enrollment_secret_configured' },
        result: 'denied',
      })
    );
    // #984: the rejection must be visible to the EnrollmentSpike anomaly metric.
    expect(recordAgentEnrollment).toHaveBeenCalledWith('error');
  });

  it('blocks production enrollment with no secret when mode is explicitly enforce', async () => {
    process.env.ENROLLMENT_SECRET_ENFORCEMENT_MODE = 'enforce';
    mockKeyLookup({
      id: 'key-mode-2',
      orgId: 'org-mode-2',
      siteId: 'site-mode-2',
      keySecretHash: null,
      expiresAt: new Date(Date.now() + 3600_000),
      maxUsage: null,
      usageCount: 0,
    });

    const resp = await buildApp().request('/agents/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseEnrollBody),
    });

    expect(resp.status).toBe(403);
  });

  it('lets production enrollment past the secret check when mode=warn, recording an audit event with enforcementMode=warn', async () => {
    process.env.ENROLLMENT_SECRET_ENFORCEMENT_MODE = 'warn';
    mockKeyLookup({
      id: 'key-mode-3',
      orgId: 'org-mode-3',
      siteId: 'site-mode-3',
      keySecretHash: null,
      expiresAt: new Date(Date.now() + 3600_000),
      maxUsage: null,
      usageCount: 0,
    });

    // Force the downstream UPDATE to claim 0 rows so we exit at the race-lost
    // branch. We don't care about the final response here — only that the
    // warn-mode audit event was recorded BEFORE we got there.
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

    // Did not get a 403 from the secret check — proves warn mode let us through.
    expect(resp.status).not.toBe(403);
    expect(writeAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        details: { reason: 'no_enrollment_secret_configured', enforcementMode: 'warn' },
        result: 'success',
      })
    );
  });

  it('mode is case-insensitive — WARN behaves the same as warn', async () => {
    process.env.ENROLLMENT_SECRET_ENFORCEMENT_MODE = 'WARN';
    mockKeyLookup({
      id: 'key-mode-4',
      orgId: 'org-mode-4',
      siteId: 'site-mode-4',
      keySecretHash: null,
      expiresAt: new Date(Date.now() + 3600_000),
      maxUsage: null,
      usageCount: 0,
    });

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

    expect(resp.status).not.toBe(403);
    expect(writeAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        details: { reason: 'no_enrollment_secret_configured', enforcementMode: 'warn' },
        result: 'success',
      })
    );
  });

  it('skips the production secret gate entirely outside production', async () => {
    process.env.NODE_ENV = 'test';
    mockKeyLookup({
      id: 'key-mode-5',
      orgId: 'org-mode-5',
      siteId: 'site-mode-5',
      keySecretHash: null,
      expiresAt: new Date(Date.now() + 3600_000),
      maxUsage: null,
      usageCount: 0,
    });

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

    expect(resp.status).not.toBe(403);
    // Critically: no warn-mode audit event because the production gate did not run.
    expect(writeAuditEvent).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        details: expect.objectContaining({ reason: 'no_enrollment_secret_configured' }),
      })
    );
  });
});

describe('POST /agents/enroll — manifestTrustKeys delivery (#639)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.AGENT_ENROLLMENT_SECRET;
    process.env.NODE_ENV = 'test';
  });

  it('includes manifestTrustKeys in the 201 response from getActiveTrustKeyset()', async () => {
    const trustKeys = [
      {
        keyId: 'deploy-2026-05-14-aaaaaaaa',
        publicKeyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        validFrom: '2026-05-14T00:00:00.000Z',
      },
    ];
    vi.mocked(manifestSigning.getActiveTrustKeyset).mockResolvedValue(
      trustKeys,
    );

    // Step 1: enrollment-key lookup returns a usable row
    mockKeyLookup({
      id: 'key-happy',
      orgId: 'org-happy',
      siteId: 'site-happy',
      keySecretHash: null,
      expiresAt: new Date(Date.now() + 3600_000),
      maxUsage: 10,
      usageCount: 0,
    });

    // Step 2: db.update for the claim → returning the claimed key
    vi.mocked(db.update).mockReturnValueOnce({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue([
            { id: 'key-happy', orgId: 'org-happy', siteId: 'site-happy' },
          ]),
        })),
      })),
    } as any);

    // Step 3: org lookup → no partner constraint
    mockSelectRows([{ partnerId: 'partner-happy' }]);
    // Step 4: partner.maxDevices lookup
    mockSelectRows([{ maxDevices: null }]);
    // Step 5: existing-device lookup → empty (fresh enrollment)
    mockSelectRows([]);

    // Step 6: db.transaction runs device INSERT then the in-tx key-consume
    // UPDATE (#946). The fake tx supports both chains:
    //   - tx.insert(devices).values(...).returning() → new device row
    //   - tx.update(enrollmentKeys).set(...).where(...).returning() → [{id}]
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => {
      const fakeTx = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 0 }]),
          }),
        }),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({
            returning: vi
              .fn()
              .mockResolvedValue([
                {
                  id: 'device-happy',
                  orgId: 'org-happy',
                  siteId: 'site-happy',
                  hostname: 'host-1',
                },
              ]),
            onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
          }),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ id: 'key-happy' }]),
            }),
          }),
        }),
        delete: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      };
      return fn(fakeTx);
    });

    const resp = await buildApp().request('/agents/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseEnrollBody),
    });

    expect(resp.status).toBe(201);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.deviceId).toBe('device-happy');
    expect(Array.isArray(body.manifestTrustKeys)).toBe(true);
    expect(body.manifestTrustKeys).toEqual(trustKeys);
    expect(manifestSigning.getActiveTrustKeyset).toHaveBeenCalled();
  });
});

// =====================================================================
// Wave 6 Task 7 — signed manifest key delegation delivery + the #1105
// enrollment ordering boundary.
//
// The delegation lookup is DATABASE work, so it is allowed to run inside
// withSystemDbAccessContext. What is NOT allowed inside that context is
// any network or queue handoff: holding a pooled connection while doing
// external I/O is exactly the conn-hold class that #1105 exists to
// prevent, and it self-deadlocks the pool under a mass reconnect.
// =====================================================================
describe('POST /agents/enroll — manifestKeyDelegations delivery (Wave 6 Task 7)', () => {
  const delegation = {
    schemaVersion: 1 as const,
    oldKeyId: 'deploy-2026-05-09-aaaaaaaa',
    newKeyId: 'deploy-2026-08-06-bbbbbbbb',
    newPublicKeyB64: 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=',
    epoch: 7,
    notBefore: '2026-08-06T00:00:00Z',
    notAfter: '2026-09-05T00:00:00Z',
    signatureBase64: 'c2ln',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.AGENT_ENROLLMENT_SECRET;
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    // vi.clearAllMocks() clears CALLS but not implementations, so the
    // gated withSystemDbAccessContext installed by the #1105 test below
    // would otherwise leak into every later suite in this file and hang
    // them. Restore the module mock's pass-through explicitly.
    vi.mocked(withSystemDbAccessContext).mockImplementation(
      async (fn: any) => fn(),
    );
  });

  function mockHappyPathDb() {
    mockKeyLookup({
      id: 'key-happy',
      orgId: 'org-happy',
      siteId: 'site-happy',
      keySecretHash: null,
      expiresAt: new Date(Date.now() + 3600_000),
      maxUsage: 10,
      usageCount: 0,
    });
    vi.mocked(db.update).mockReturnValueOnce({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi
            .fn()
            .mockResolvedValue([
              { id: 'key-happy', orgId: 'org-happy', siteId: 'site-happy' },
            ]),
        })),
      })),
    } as any);
    mockSelectRows([{ partnerId: 'partner-happy' }]);
    mockSelectRows([{ maxDevices: null }]);
    mockSelectRows([]);
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => {
      const fakeTx = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 0 }]),
          }),
        }),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([
              {
                id: 'device-happy',
                orgId: 'org-happy',
                siteId: 'site-happy',
                hostname: 'host-1',
              },
            ]),
            onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
          }),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ id: 'key-happy' }]),
            }),
          }),
        }),
        delete: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      };
      return fn(fakeTx);
    });
  }

  async function enroll() {
    return buildApp().request('/agents/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseEnrollBody),
    });
  }

  it('includes manifestKeyDelegations in the 201 response', async () => {
    vi.mocked(manifestSigning.getActiveTrustKeyset).mockResolvedValue([]);
    vi.mocked(
      manifestSigning.getActiveManifestKeyDelegations,
    ).mockResolvedValue([delegation]);
    mockHappyPathDb();

    const resp = await enroll();
    expect(resp.status).toBe(201);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.manifestKeyDelegations).toEqual([delegation]);
  });

  it('returns manifestKeyDelegations=[] when none are prepared', async () => {
    vi.mocked(manifestSigning.getActiveTrustKeyset).mockResolvedValue([]);
    vi.mocked(
      manifestSigning.getActiveManifestKeyDelegations,
    ).mockResolvedValue([]);
    mockHappyPathDb();

    const resp = await enroll();
    expect(resp.status).toBe(201);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.manifestKeyDelegations).toEqual([]);
  });

  it('still enrolls (201) with an empty delegation list when the lookup throws', async () => {
    // A delegation-lookup failure must never block enrollment — the device
    // simply adopts on a later heartbeat.
    vi.mocked(manifestSigning.getActiveTrustKeyset).mockResolvedValue([]);
    vi.mocked(
      manifestSigning.getActiveManifestKeyDelegations,
    ).mockRejectedValue(new Error('boom'));
    mockHappyPathDb();

    const resp = await enroll();
    expect(resp.status).toBe(201);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.manifestKeyDelegations).toEqual([]);
  });

  it('#1105: does NOT queue warranty sync (or any external handoff) while the system DB context is unresolved, and still queues it after', async () => {
    vi.mocked(manifestSigning.getActiveTrustKeyset).mockResolvedValue([]);
    vi.mocked(
      manifestSigning.getActiveManifestKeyDelegations,
    ).mockResolvedValue([delegation]);
    mockHappyPathDb();

    // Hold the system DB context open: its callback completes, but the
    // context itself does not resolve until we release the gate. In
    // production this models the pooled connection still being held.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(withSystemDbAccessContext).mockImplementation(
      async (fn: any) => {
        const result = await fn();
        await gate;
        return result;
      },
    );

    // Any network egress from inside the context would show up here.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('no network calls are permitted here'));

    const inFlight = enroll();
    // Let the handler run as far as it can while the context is held.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The DB lookup for delegations is allowed inside the context and has
    // already happened...
    expect(
      manifestSigning.getActiveManifestKeyDelegations,
    ).toHaveBeenCalled();
    // ...but nothing has been handed off externally.
    expect(queueWarrantySyncForDevice).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();

    release();
    const resp = await inFlight;
    expect(resp.status).toBe(201);

    // The pre-existing enqueue still fires once the context has resolved.
    expect(queueWarrantySyncForDevice).toHaveBeenCalledTimes(1);
    expect(queueWarrantySyncForDevice).toHaveBeenCalledWith('device-happy');
    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });
});

describe('POST /agents/enroll — enrollment key not consumed on failed device insert (#946)', () => {
  // Issue #946: pre-fix, `enrollment_keys.usage_count` was incremented during
  // key validation, before the device INSERT. Any post-validation failure
  // (hostname collision, device-limit, suspended-decom-token, etc.) would
  // silently burn a single-use key without ever creating a device — leaving
  // the customer with an exhausted key and no enrolled host.
  //
  // Post-fix: the increment is the last statement inside the device
  // transaction. Failures roll back the device INSERT *and* the increment
  // atomically; a successful enrollment is the only path that bumps the
  // counter.

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.AGENT_ENROLLMENT_SECRET;
    process.env.NODE_ENV = 'test';
  });

  it('consumes the key only inside the transaction on the hostname-collision fresh-row path (#2764)', async () => {
    // maxUsage: 1, usageCount: 0 — a single-use key. Pre-#2764 the collision
    // returned 409 before the transaction opened; post-#2764 it enrolls a
    // fresh row, so the key IS legitimately consumed — but still only by the
    // in-transaction update, never by a standalone pre-insert db.update.
    mockKeyLookup({
      id: 'key-once',
      orgId: 'org-once',
      siteId: 'site-once',
      keySecretHash: null,
      expiresAt: new Date(Date.now() + 3600_000),
      maxUsage: 1,
      usageCount: 0,
    });

    mockSelectRows([{ partnerId: 'partner-once' }]);
    mockSelectRows([{ maxDevices: null }]);
    // Existing device row that collides on hostname
    mockSelectRows([{
      id: 'device-collision',
      status: 'online',
      agentTokenHash: 'someone-elses-token',
      previousTokenHash: null,
      previousTokenExpiresAt: null,
      agentTokenSuspendedAt: null,
    }]);

    const tx = mockTransaction({
      id: 'device-collision-fresh-once',
      orgId: 'org-once',
      siteId: 'site-once',
      hostname: 'host-1',
    }, 'key-once');

    const resp = await buildApp().request('/agents/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseEnrollBody),
    });

    expect(resp.status).toBe(201);
    // No standalone pre-insert increment.
    expect(db.update).not.toHaveBeenCalled();
    // The only in-tx update is the enrollment-key consume — never devices.
    expect(tx.update).toHaveBeenCalledTimes(1);
    expect(tx.updatedTables).not.toContain(devicesTable);
  });

  it('does NOT call db.update(enrollment_keys) on the suspended-decom-token 409 path', async () => {
    // Another failure path that previously consumed the key — a decommissioned
    // row whose token was probe-suspended. The route returns 409 before any
    // device write, and the fix means the counter is untouched.
    mockKeyLookup({
      id: 'key-suspended',
      orgId: 'org-suspended',
      siteId: 'site-suspended',
      keySecretHash: null,
      expiresAt: new Date(Date.now() + 3600_000),
      maxUsage: 1,
      usageCount: 0,
    });

    mockSelectRows([{ partnerId: 'partner-suspended' }]);
    mockSelectRows([{ maxDevices: null }]);
    mockSelectRows([{
      id: 'device-suspended',
      status: 'decommissioned',
      agentTokenHash: 'old-hash',
      previousTokenHash: null,
      previousTokenExpiresAt: null,
      agentTokenSuspendedAt: new Date('2026-05-25T12:00:00Z'),
    }]);

    const resp = await buildApp().request('/agents/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseEnrollBody),
    });

    expect(resp.status).toBe(409);
    expect(db.update).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('consumes the key ONLY inside the device transaction on the success path', async () => {
    // Happy path: lookup → org/partner → no existing device → transaction
    // opens → INSERT new device → consume key inside the same tx → 201.
    // Asserts that the standalone pre-insert db.update is gone (it would
    // have been called exactly once before the device write), and that the
    // tx-internal update of enrollment_keys WAS called (the new location).
    mockKeyLookup({
      id: 'key-success',
      orgId: 'org-success',
      siteId: 'site-success',
      keySecretHash: null,
      expiresAt: new Date(Date.now() + 3600_000),
      maxUsage: 1,
      usageCount: 0,
    });

    mockSelectRows([{ partnerId: 'partner-success' }]);
    mockSelectRows([{ maxDevices: null }]);
    mockSelectRows([]); // no existing device

    let txUpdateCalls = 0;
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => {
      const fakeTx = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 0 }]),
          }),
        }),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{
              id: 'device-success',
              orgId: 'org-success',
              siteId: 'site-success',
              hostname: 'host-1',
            }]),
            onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
          }),
        }),
        update: vi.fn(() => {
          txUpdateCalls += 1;
          return {
            set: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                returning: vi.fn().mockResolvedValue([{ id: 'key-success' }]),
              }),
            }),
          };
        }),
        delete: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      };
      return fn(fakeTx);
    });

    const resp = await buildApp().request('/agents/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseEnrollBody),
    });

    expect(resp.status).toBe(201);
    // The standalone pre-insert UPDATE is gone — db.update (the top-level
    // mock) is never called.
    expect(db.update).not.toHaveBeenCalled();
    // The transaction's tx.update WAS called exactly once: to consume the key.
    expect(txUpdateCalls).toBe(1);
  });

  it('rolls back the key consume when the in-transaction claim loses the TOCTOU race', async () => {
    // Race scenario: lookup observed maxUsage > usageCount, device INSERT
    // succeeded, but a concurrent enrollment drained the last slot before
    // we got to the consume step. The in-tx UPDATE returns 0 rows; the
    // route throws the sentinel and the transaction rolls back. Device
    // INSERT is undone; counter unchanged. Response is 401
    // enrollment_key_race_lost (same wire-format as before the move).
    mockKeyLookup({
      id: 'key-race',
      orgId: 'org-race',
      siteId: 'site-race',
      keySecretHash: null,
      expiresAt: new Date(Date.now() + 3600_000),
      maxUsage: 1,
      usageCount: 0,
    });

    mockSelectRows([{ partnerId: 'partner-race' }]);
    mockSelectRows([{ maxDevices: null }]);
    mockSelectRows([]); // no existing device

    let txUpdateReturnedZero = false;
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => {
      const fakeTx = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 0 }]),
          }),
        }),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{
              id: 'device-race',
              orgId: 'org-race',
              siteId: 'site-race',
              hostname: 'host-1',
            }]),
            onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
          }),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn(() => {
                txUpdateReturnedZero = true;
                return Promise.resolve([]);
              }),
            }),
          }),
        }),
        delete: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      };
      // The real Postgres transaction would re-throw the sentinel and
      // rollback. We propagate the throw so the outer route handler
      // catches it and surfaces the 401.
      return fn(fakeTx);
    });

    const resp = await buildApp().request('/agents/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseEnrollBody),
    });

    expect(resp.status).toBe(401);
    const body = await resp.json();
    expect(body.reason).toBe('enrollment_key_race_lost');
    expect(txUpdateReturnedZero).toBe(true);
    expect(writeAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        details: expect.objectContaining({ reason: 'enrollment_key_race_lost' }),
        result: 'denied',
      })
    );
  });

  it('does not increment for bogus keys — 401 enrollment_key_not_found writes nothing', async () => {
    // Anti-goal guard: the validation itself must remain eager. A bogus
    // key 401s without any DB write (no lookup-row, no update, no txn).
    mockKeyLookup(undefined);

    const resp = await buildApp().request('/agents/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseEnrollBody),
    });

    expect(resp.status).toBe(401);
    expect(db.update).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });
});

describe('POST /agents/enroll — virtualization attribute persistence (#1387)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.AGENT_ENROLLMENT_SECRET;
    process.env.NODE_ENV = 'test';
  });

  // Stands up the full happy enrollment path and returns the spy that captures
  // the device INSERT .values(...) payload so a test can assert the persisted
  // virtualization columns.
  function arrangeFreshEnroll() {
    mockKeyLookup({
      id: 'key-virt',
      orgId: 'org-virt',
      siteId: 'site-virt',
      keySecretHash: null,
      expiresAt: new Date(Date.now() + 3600_000),
      maxUsage: 10,
      usageCount: 0,
    });
    vi.mocked(db.update).mockReturnValueOnce({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue([
            { id: 'key-virt', orgId: 'org-virt', siteId: 'site-virt' },
          ]),
        })),
      })),
    } as any);
    mockSelectRows([{ partnerId: 'partner-virt' }]); // org lookup
    mockSelectRows([{ maxDevices: null }]); // partner.maxDevices
    mockSelectRows([]); // existing-device lookup → fresh

    const deviceInsertValues = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([
        { id: 'device-virt', orgId: 'org-virt', siteId: 'site-virt', hostname: 'host-1' },
      ]),
      onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
    });
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => {
      const fakeTx = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 0 }]),
          }),
        }),
        insert: vi.fn().mockReturnValue({ values: deviceInsertValues }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ id: 'key-virt' }]),
            }),
          }),
        }),
        delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      };
      return fn(fakeTx);
    });
    return deviceInsertValues;
  }

  it('persists isVirtual + virtualizationPlatform from the enroll payload', async () => {
    const deviceInsertValues = arrangeFreshEnroll();
    const resp = await buildApp().request('/agents/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...baseEnrollBody, isVirtual: true, virtualizationPlatform: 'hyperv' }),
    });
    expect(resp.status).toBe(201);
    // First insert call is the devices row.
    const deviceValues = (deviceInsertValues.mock.calls as any[])[0]?.[0] as Record<string, unknown>;
    expect(deviceValues.isVirtual).toBe(true);
    expect(deviceValues.virtualizationPlatform).toBe('hyperv');
  });

  it('persists a fresh enrollment as pending without fabricating a last-seen timestamp', async () => {
    const deviceInsertValues = arrangeFreshEnroll();
    const resp = await buildApp().request('/agents/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseEnrollBody),
    });

    expect(resp.status).toBe(201);
    const deviceValues = (deviceInsertValues.mock.calls as any[])[0]?.[0] as Record<string, unknown>;
    expect(deviceValues.status).toBe('pending');
    expect(deviceValues).not.toHaveProperty('lastSeenAt');
  });

  it('defaults to isVirtual=false / null platform when the agent omits the fields', async () => {
    const deviceInsertValues = arrangeFreshEnroll();
    const resp = await buildApp().request('/agents/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseEnrollBody), // no virtualization fields
    });
    expect(resp.status).toBe(201);
    const deviceValues = (deviceInsertValues.mock.calls as any[])[0]?.[0] as Record<string, unknown>;
    expect(deviceValues.isVirtual).toBe(false);
    expect(deviceValues.virtualizationPlatform).toBeNull();
  });

  it('carries the virtualization fields onto the fresh-id INSERT when re-enrolling over a decommissioned row (#914 path)', async () => {
    // The decom-bypass-fresh-id branch is a SECOND device INSERT site (it
    // renames the old row then inserts a new one). Assert it also persists the
    // virtualization attribute so a VM reinstalling onto a decommissioned
    // hostname keeps its is_virtual/platform.
    mockKeyLookup({
      id: 'key-decom-virt',
      orgId: 'org-decom-virt',
      siteId: 'site-decom-virt',
      keySecretHash: null,
      expiresAt: new Date(Date.now() + 3600_000),
      maxUsage: 10,
      usageCount: 0,
    });
    vi.mocked(db.update).mockReturnValueOnce({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue([
            { id: 'key-decom-virt', orgId: 'org-decom-virt', siteId: 'site-decom-virt' },
          ]),
        })),
      })),
    } as any);
    mockSelectRows([{ partnerId: 'partner-decom-virt' }]);
    mockSelectRows([{ maxDevices: null }]);
    // Existing row is DECOMMISSIONED, no token on the request → decom-bypass-fresh-id.
    mockSelectRows([{
      id: 'device-decom-existing',
      status: 'decommissioned',
      agentTokenHash: 'old-decom-hash',
      previousTokenHash: null,
      previousTokenExpiresAt: null,
    }]);

    const deviceInsertValues = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([
        { id: 'device-decom-fresh', orgId: 'org-decom-virt', siteId: 'site-decom-virt', hostname: 'host-1' },
      ]),
      onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
    });
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => {
      const fakeTx = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([{ count: 0 }]) }),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn(() => Object.assign(
              Promise.resolve(undefined) as any,
              { returning: vi.fn().mockResolvedValue([{ id: 'key-decom-virt' }]) },
            )),
          }),
        }),
        insert: vi.fn().mockReturnValue({ values: deviceInsertValues }),
        delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      };
      return fn(fakeTx);
    });

    const resp = await buildApp().request('/agents/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...baseEnrollBody, isVirtual: true, virtualizationPlatform: 'vmware' }),
    });
    expect(resp.status).toBe(201);
    const deviceValues = (deviceInsertValues.mock.calls as any[])[0]?.[0] as Record<string, unknown>;
    expect(deviceValues.isVirtual).toBe(true);
    expect(deviceValues.virtualizationPlatform).toBe('vmware');
  });
});

describe('POST /agents/enroll — enrollment IP persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.AGENT_ENROLLMENT_SECRET;
    process.env.NODE_ENV = 'test';
    vi.mocked(partnerTrustMode).mockReturnValue('off');
  });

  // Stands up the full happy fresh-enroll path and returns the spy that
  // captures the device INSERT .values(...) payload, mirroring
  // arrangeFreshEnroll() above (#1387) — a mechanical extraction so this
  // test (and any future ones) can assert on the persisted enrollmentIp.
  function setupSuccessfulEnrollTransaction() {
    mockKeyLookup({
      id: 'key-ip',
      orgId: 'org-ip',
      siteId: 'site-ip',
      keySecretHash: null,
      expiresAt: new Date(Date.now() + 3600_000),
      maxUsage: 10,
      usageCount: 0,
    });
    vi.mocked(db.update).mockReturnValueOnce({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue([
            { id: 'key-ip', orgId: 'org-ip', siteId: 'site-ip' },
          ]),
        })),
      })),
    } as any);
    mockSelectRows([{ partnerId: 'partner-ip' }]); // org lookup
    mockSelectRows([{ maxDevices: null }]); // partner.maxDevices
    mockSelectRows([]); // existing-device lookup → fresh

    const deviceInsertValues = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([
        { id: 'device-ip', orgId: 'org-ip', siteId: 'site-ip', hostname: 'host-1' },
      ]),
      onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
    });
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => {
      const fakeTx = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 0 }]),
          }),
        }),
        insert: vi.fn().mockReturnValue({ values: deviceInsertValues }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ id: 'key-ip' }]),
            }),
          }),
        }),
        delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      };
      return fn(fakeTx);
    });
    return deviceInsertValues;
  }

  it('persists the enrolling client IP on the new device row', async () => {
    const deviceInsertValues = setupSuccessfulEnrollTransaction();
    const resp = await buildApp().request('/agents/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseEnrollBody),
    });
    expect(resp.status).toBe(201);
    expect(deviceInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ enrollmentIp: '127.0.0.1' }),
    );
  });

  it('fire-and-forgets IP classification after a successful hosted enrollment', async () => {
    // The first mode read is the in-transaction probation gate; keep this
    // fixture on its simple trusted path. The post-commit read enables the
    // enqueue under test.
    vi.mocked(partnerTrustMode).mockReturnValueOnce('off').mockReturnValue('shadow');
    setupSuccessfulEnrollTransaction();
    const resp = await buildApp().request('/agents/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseEnrollBody),
    });
    expect(resp.status).toBe(201);
    expect(enqueueIpClassify).toHaveBeenCalledWith({
      kind: 'device', deviceId: 'device-ip', ip: '127.0.0.1',
    });
  });

  it('stores NULL enrollmentIp when the client IP could not be determined', async () => {
    vi.mocked(getTrustedClientIp).mockReturnValueOnce('unknown');
    const deviceInsertValues = setupSuccessfulEnrollTransaction();
    const resp = await buildApp().request('/agents/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseEnrollBody),
    });
    expect(resp.status).toBe(201);
    expect(deviceInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ enrollmentIp: null }),
    );
  });
});

describe('POST /agents/enroll — Quick Support ephemeral enrollment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.AGENT_ENROLLMENT_SECRET;
    process.env.NODE_ENV = 'test';
  });

  interface SupportTxSpy {
    /** values() handed to tx.insert(devices). */
    deviceInsertValues: Record<string, unknown>[];
    /** Every tx.update(...) as [table, setPayload]. */
    updates: Array<{ table: unknown; values: Record<string, unknown> }>;
    /** where() conditions handed to the in-transaction licence count. */
    countWhere: unknown[];
  }

  function mockSupportTransaction(countAtCap = 0): SupportTxSpy {
    const spy: SupportTxSpy = { deviceInsertValues: [], updates: [], countWhere: [] };

    vi.mocked(db.transaction).mockImplementation(async (fn: any) => {
      const fakeTx = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn((cond: unknown) => {
              spy.countWhere.push(cond);
              return Promise.resolve([{ count: countAtCap }]);
            }),
          }),
        }),
        insert: vi.fn((table: unknown) => ({
          values: vi.fn((values: Record<string, unknown>) => {
            if (table === devicesTable) spy.deviceInsertValues.push(values);
            return {
              returning: vi.fn().mockResolvedValue([
                { id: 'device-support', orgId: 'org-support', siteId: 'site-support', hostname: 'host-1' },
              ]),
              onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
            };
          }),
        })),
        update: vi.fn((table: unknown) => ({
          set: vi.fn((values: Record<string, unknown>) => {
            spy.updates.push({ table, values });
            return {
              where: vi.fn(() => Object.assign(
                Promise.resolve(undefined) as any,
                { returning: vi.fn().mockResolvedValue([{ id: 'key-support' }]) },
              )),
            };
          }),
        })),
        delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      };
      return fn(fakeTx);
    });

    return spy;
  }

  /**
   * The two db.select calls a REJECTED support enrollment consumes: the key
   * lookup and the support-session lookup. Queueing only what the handler
   * actually reads matters — `mockReturnValueOnce` entries survive
   * `clearAllMocks`, so an over-queued rejection test corrupts the next one.
   * `session: null` stands in for a purged session row.
   */
  function arrangeSupportKey(session: { status: string; hardExpiresAt: Date } | null) {
    mockKeyLookup({
      id: 'key-support',
      orgId: 'org-support',
      siteId: 'site-support',
      keySecretHash: null,
      expiresAt: new Date(Date.now() + 3600_000),
      maxUsage: 1,
      usageCount: 0,
      supportSessionId: 'session-1',
    });
    mockSelectRows(session ? [session] : []); // support-session lookup
  }

  /** Full select sequence for an accepted support enrollment. */
  function arrangeSupportEnroll(
    session: { status: string; hardExpiresAt: Date },
    maxDevices: number | null = null,
  ) {
    arrangeSupportKey(session);
    mockSelectRows([{ partnerId: 'partner-support' }]); // org lookup
    mockSelectRows([{ maxDevices }]); // partner.maxDevices
    mockSelectRows([]); // no colliding device
  }

  function enroll() {
    return buildApp().request('/agents/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseEnrollBody),
    });
  }

  it('marks the device ephemeral and binds it to the claimed session in the same transaction', async () => {
    arrangeSupportEnroll({ status: 'claimed', hardExpiresAt: new Date(Date.now() + 3600_000) });
    const spy = mockSupportTransaction();

    const resp = await enroll();

    expect(resp.status).toBe(201);
    expect(spy.deviceInsertValues[0]).toEqual(
      expect.objectContaining({ isEphemeral: true }),
    );
    // The session must learn its device id, or the technician's session never
    // becomes connectable.
    expect(spy.updates).toContainEqual({
      table: supportSessionsTable,
      values: { deviceId: 'device-support' },
    });
  });

  it.each(['ended', 'expired', 'pending'])(
    'rejects a support key whose session is %s, with the generic expired-key shape',
    async (status) => {
      arrangeSupportKey({ status, hardExpiresAt: new Date(Date.now() + 3600_000) });
      const spy = mockSupportTransaction();

      const resp = await enroll();

      expect(resp.status).toBe(401);
      const body = (await resp.json()) as Record<string, unknown>;
      expect(body.reason).toBe('enrollment_key_expired');
      expect(spy.deviceInsertValues).toHaveLength(0);
      expect(writeAuditEvent).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          result: 'denied',
          details: expect.objectContaining({
            reason: 'support_session_not_claimable',
            supportSessionId: 'session-1',
            sessionStatus: status,
          }),
        }),
      );
    },
  );

  it('rejects a claimed session that has passed its hard expiry', async () => {
    arrangeSupportKey({ status: 'claimed', hardExpiresAt: new Date(Date.now() - 1_000) });
    const spy = mockSupportTransaction();

    const resp = await enroll();

    expect(resp.status).toBe(401);
    expect(spy.deviceInsertValues).toHaveLength(0);
  });

  it('rejects a support key whose session row no longer exists', async () => {
    arrangeSupportKey(null);
    const spy = mockSupportTransaction();

    const resp = await enroll();

    expect(resp.status).toBe(401);
    expect(spy.deviceInsertValues).toHaveLength(0);
  });

  it('enrolls even when the partner is at its device limit — a support session is not a licensed endpoint', async () => {
    arrangeSupportEnroll({ status: 'claimed', hardExpiresAt: new Date(Date.now() + 3600_000) }, 2);
    const spy = mockSupportTransaction(2); // fleet already at the cap

    const resp = await enroll();

    expect(resp.status).toBe(201);
    // The cap block is skipped wholesale, so the count query never runs.
    expect(spy.countWhere).toHaveLength(0);
    expect(spy.deviceInsertValues[0]).toEqual(
      expect.objectContaining({ isEphemeral: true }),
    );
  });

  it('leaves an ordinary enrollment non-ephemeral and touches no support session', async () => {
    mockKeyLookup({
      id: 'key-normal',
      orgId: 'org-normal',
      siteId: 'site-normal',
      keySecretHash: null,
      expiresAt: new Date(Date.now() + 3600_000),
      maxUsage: 10,
      usageCount: 0,
      supportSessionId: null,
    });
    mockSelectRows([{ partnerId: 'partner-normal' }]);
    mockSelectRows([{ maxDevices: null }]);
    mockSelectRows([]);
    const spy = mockSupportTransaction();

    const resp = await enroll();

    expect(resp.status).toBe(201);
    expect(spy.deviceInsertValues[0]).toEqual(
      expect.objectContaining({ isEphemeral: false }),
    );
    expect(spy.updates.some((u) => u.table === supportSessionsTable)).toBe(false);
  });

  it('excludes ephemeral rows from the partner licence count', async () => {
    mockKeyLookup({
      id: 'key-count',
      orgId: 'org-count',
      siteId: 'site-count',
      keySecretHash: null,
      expiresAt: new Date(Date.now() + 3600_000),
      maxUsage: 10,
      usageCount: 0,
      supportSessionId: null,
    });
    mockSelectRows([{ partnerId: 'partner-count' }]);
    mockSelectRows([{ maxDevices: 5 }]); // cap set, so the count actually runs
    mockSelectRows([]);
    const spy = mockSupportTransaction(1);

    const resp = await enroll();

    expect(resp.status).toBe(201);
    // [0] is the partnerOrgIds subquery's where, [1] the fleet count itself.
    expect(spy.countWhere).toHaveLength(2);
    // The mocked schema names the column 'devices.isEphemeral', so its presence
    // in the serialized condition proves the exclusion reached the SQL — a
    // regression here silently re-bills every Quick Support session.
    expect(JSON.stringify(spy.countWhere[1])).toContain('devices.isEphemeral');
  });
});
