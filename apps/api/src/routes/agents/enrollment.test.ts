import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
}));

vi.mock('../../modules/mcpInvites/matchInviteOnEnrollment', () => ({
  matchDeploymentInviteOnEnrollment: vi.fn(async () => undefined),
}));

vi.mock('../../services/sentry', () => ({
  captureException: vi.fn(),
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
  queueWarrantySyncForDevice: vi.fn(async () => undefined),
}));

vi.mock('../../services/partnerHooks', () => ({
  dispatchHook: vi.fn(),
}));

// ---------- imports after mocks ----------

import { db } from '../../db';
import { writeAuditEvent } from '../../services/auditEvents';
import * as manifestSigning from '../../services/manifestSigning';
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

  it('regression: status=offline (not decommissioned) still 409s without an existing-device token', async () => {
    // Defense against future refactors that might widen the decommissioned
    // bypass — make sure 'offline' rows continue to require the prior token.
    mockKeyLookup({
      id: 'key-offline',
      orgId: 'org-offline',
      siteId: 'site-offline',
      keySecretHash: null,
      expiresAt: new Date(Date.now() + 3600_000),
      maxUsage: 10,
      usageCount: 0,
    });

    vi.mocked(db.update).mockReturnValueOnce({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue([{
            id: 'key-offline',
            orgId: 'org-offline',
            siteId: 'site-offline',
          }]),
        })),
      })),
    } as any);

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
    }]);

    const resp = await buildApp().request('/agents/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseEnrollBody),
    });

    expect(resp.status).toBe(409);
    const body = await resp.json();
    expect(body.reason).toBe('hostname_collision_requires_existing_device_token');
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

  it('does NOT call db.update(enrollment_keys) on the hostname-collision 409 path', async () => {
    // maxUsage: 1, usageCount: 0 — a single-use key. The hostname-collision
    // path returns 409 BEFORE the transaction opens. The buggy code path
    // would have bumped usage_count to 1 here (now permanently exhausted).
    // The fix never touches the row.
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
    // Existing device row in a status that triggers a hostname-collision 409
    mockSelectRows([{
      id: 'device-collision',
      status: 'online',
      agentTokenHash: 'someone-elses-token',
      previousTokenHash: null,
      previousTokenExpiresAt: null,
    }]);

    const resp = await buildApp().request('/agents/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseEnrollBody),
    });

    expect(resp.status).toBe(409);
    const body = await resp.json();
    expect(body.reason).toBe('hostname_collision_requires_existing_device_token');

    // The fix: db.update was never invoked (no standalone pre-insert
    // increment, no transaction opened). Pre-fix, db.update would have
    // been called exactly once to bump usage_count.
    expect(db.update).not.toHaveBeenCalled();
    // And no transaction was opened, so the in-tx consume never ran either.
    expect(db.transaction).not.toHaveBeenCalled();
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
