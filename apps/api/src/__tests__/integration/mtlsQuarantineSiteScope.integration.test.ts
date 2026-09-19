/**
 * Quarantine administration boundary against real PostgreSQL as breeze_app.
 *
 * The unit suite pins handler ordering and generated predicates. This suite
 * proves that forced RLS, site filtering, and the exact preflight-site CAS
 * compose correctly against actual rows and a real concurrent site move.
 */
import './setup';
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import { withDbAccessContext, type DbAccessContext } from '../../db';
import { devices } from '../../db/schema';
import { getTestDb } from './setup';
import { createOrganization, createPartner, createSite } from './db-utils';

const {
  authState,
  issueMtlsCertForDeviceMock,
  terminateDeviceRemoteSessionsMock,
  writeAuditEventMock,
} = vi.hoisted(() => ({
  authState: {
    orgId: '',
    allowedSiteIds: undefined as string[] | undefined,
  },
  issueMtlsCertForDeviceMock: vi.fn(async () => null),
  terminateDeviceRemoteSessionsMock: vi.fn(async () => 0),
  writeAuditEventMock: vi.fn(),
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('auth', {
      user: { id: '11111111-1111-4111-8111-111111111111' },
      canAccessOrg: (orgId: string) => orgId === authState.orgId,
    });
    return next();
  },
  requirePermission: () => async (c: any, next: any) => {
    c.set('permissions', {
      permissions: [{ resource: 'devices', action: 'write' }],
      allowedSiteIds: authState.allowedSiteIds,
    });
    return next();
  },
  requireMfa: () => async (_c: any, next: any) => next(),
}));

vi.mock('../../routes/agents/helpers', () => ({
  getOrgHelperSettings: vi.fn(async () => ({ enabled: true })),
  issueMtlsCertForDevice: issueMtlsCertForDeviceMock,
  isObject: (value: unknown) => typeof value === 'object' && value !== null && !Array.isArray(value),
}));

vi.mock('../../services/auditEvents', () => ({ writeAuditEvent: writeAuditEventMock }));
vi.mock('../../services/remoteSessionTeardown', () => ({
  terminateDeviceRemoteSessions: terminateDeviceRemoteSessionsMock,
  TEARDOWN_FAILED: -1,
}));
vi.mock('../../routes/agentWs', () => ({ disconnectAgent: vi.fn() }));

import { mtlsRoutes } from '../../routes/agents/mtls';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function orgContext(orgId: string, partnerId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [partnerId],
    currentPartnerId: partnerId,
  };
}

function app(): Hono {
  const instance = new Hono();
  instance.route('/agents', mtlsRoutes);
  return instance;
}

async function requestForOrg(
  partnerId: string,
  orgId: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  authState.orgId = orgId;
  return withDbAccessContext(orgContext(orgId, partnerId), async () => app().request(path, init));
}

async function seedDevice(orgId: string, siteId: string, suffix: string) {
  const [device] = await getTestDb()
    .insert(devices)
    .values({
      orgId,
      siteId,
      agentId: `quarantine-it-${suffix}`,
      hostname: `quarantine-${suffix}`,
      osType: 'linux',
      osVersion: 'test',
      architecture: 'x86_64',
      agentVersion: 'test',
      status: 'quarantined',
      quarantinedAt: new Date(),
      quarantinedReason: 'synthetic integration fixture',
    })
    .returning();
  if (!device) throw new Error('failed to seed device');
  return device;
}

async function fixture() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const foreignOrg = await createOrganization({ partnerId: partner.id });
  const allowedSite = await createSite({ orgId: org.id, name: 'Allowed' });
  const secondAllowedSite = await createSite({ orgId: org.id, name: 'Second allowed' });
  const hiddenSite = await createSite({ orgId: org.id, name: 'Hidden' });
  const foreignSite = await createSite({ orgId: foreignOrg.id, name: 'Foreign' });
  const allowed = await seedDevice(org.id, allowedSite.id, 'allowed');
  const hidden = await seedDevice(org.id, hiddenSite.id, 'hidden');
  const foreign = await seedDevice(foreignOrg.id, foreignSite.id, 'foreign');
  return { partner, org, allowedSite, secondAllowedSite, hiddenSite, allowed, hidden, foreign };
}

// Attach rejection handlers as operations start and settle them after releasing
// the barrier. Cleanup must retain the original assertion or operation error.
function startedOperations() {
  const pending: Promise<PromiseSettledResult<unknown>[]>[] = [];
  return {
    track<T>(operation: Promise<T>): Promise<T> {
      pending.push(Promise.allSettled([operation]));
      return operation;
    },
    async drain(primaryFailed: boolean) {
      const results = (await Promise.all(pending)).flat();
      const rejected = results.find((result) => result.status === 'rejected');
      if (!primaryFailed && rejected?.status === 'rejected') throw rejected.reason;
    },
  };
}

describe('quarantine administration site scope (real PostgreSQL, breeze_app)', () => {
  runDb('filters list and enforces allowed, hidden, cross-org, and null controls', async () => {
    const fx = await fixture();
    authState.allowedSiteIds = [fx.allowedSite.id];
    issueMtlsCertForDeviceMock.mockClear();
    terminateDeviceRemoteSessionsMock.mockClear();
    writeAuditEventMock.mockClear();

    const list = await requestForOrg(fx.partner.id, fx.org.id, '/agents/quarantined');
    expect(list.status).toBe(200);
    expect((await list.json()).devices.map((row: { id: string }) => row.id)).toEqual([fx.allowed.id]);

    const hidden = await requestForOrg(fx.partner.id, fx.org.id, `/agents/${fx.hidden.id}/approve`, { method: 'POST' });
    expect(hidden.status).toBe(403);
    expect(issueMtlsCertForDeviceMock).not.toHaveBeenCalled();
    expect(terminateDeviceRemoteSessionsMock).not.toHaveBeenCalled();
    expect(writeAuditEventMock).not.toHaveBeenCalled();

    const foreign = await requestForOrg(fx.partner.id, fx.org.id, `/agents/${fx.foreign.id}/deny`, { method: 'POST' });
    expect(foreign.status).toBe(404);
    expect(issueMtlsCertForDeviceMock).not.toHaveBeenCalled();
    expect(terminateDeviceRemoteSessionsMock).not.toHaveBeenCalled();
    expect(writeAuditEventMock).not.toHaveBeenCalled();

    const approved = await requestForOrg(fx.partner.id, fx.org.id, `/agents/${fx.allowed.id}/approve`, { method: 'POST' });
    expect(approved.status).toBe(200);
    expect(issueMtlsCertForDeviceMock).toHaveBeenCalledWith(fx.allowed.id, fx.org.id);
    expect(writeAuditEventMock).toHaveBeenCalledOnce();

    // Current schema makes site_id NOT NULL. Pin that DB control rather than
    // fabricating an impossible route row; the unit suite covers the route's
    // defensive null fail-closed branches for legacy/drifted data.
    await expect(
      getTestDb().insert(devices).values({
        orgId: fx.org.id,
        siteId: null as never,
        agentId: 'quarantine-it-null',
        hostname: 'quarantine-null',
        osType: 'linux',
        osVersion: 'test',
        architecture: 'x86_64',
        agentVersion: 'test',
        status: 'quarantined',
      }),
    ).rejects.toMatchObject({ cause: { code: '23502' } });
  });

  runDb.each(['approve', 'deny'] as const)(
    'loses the %s CAS when the device moves A -> B inside the same allowlist',
    async (action) => {
      const fx = await fixture();
      authState.allowedSiteIds = [fx.allowedSite.id, fx.secondAllowedSite.id];
      issueMtlsCertForDeviceMock.mockClear();
      terminateDeviceRemoteSessionsMock.mockClear();
      writeAuditEventMock.mockClear();

      let releaseLock!: () => void;
      let locked!: () => void;
      const lockReady = new Promise<void>((resolve) => { locked = resolve; });
      const release = new Promise<void>((resolve) => { releaseLock = resolve; });
      const started = startedOperations();
      let primaryFailed = false;
      try {
        const mover = started.track(getTestDb().transaction(async (tx) => {
          await tx.select({ id: devices.id }).from(devices).where(eq(devices.id, fx.allowed.id)).for('update');
          locked();
          await release;
          await tx.update(devices).set({ siteId: fx.secondAllowedSite.id }).where(eq(devices.id, fx.allowed.id));
        }));
        await Promise.race([lockReady, mover.then(() => {
          throw new Error('site mover ended before acquiring its barrier');
        })]);

        const responsePromise = started.track(requestForOrg(
          fx.partner.id,
          fx.org.id,
          `/agents/${fx.allowed.id}/${action}`,
          { method: 'POST' },
        ));

        // Wait until the real breeze_app UPDATE is blocked behind the mover's
        // row lock. At that point preflight definitely observed site A.
        let updateBlocked = false;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const result = await getTestDb().execute(sql<{ blocked: boolean }>`
            SELECT EXISTS (
              SELECT 1 FROM pg_stat_activity
              WHERE usename = 'breeze_app'
                AND wait_event_type = 'Lock'
                AND lower(query) LIKE 'update %devices%'
            ) AS blocked
          `);
          updateBlocked = result[0]?.blocked === true;
          if (updateBlocked) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(updateBlocked).toBe(true);
        releaseLock();
        await mover;

        const response = await responsePromise;
        expect(response.status).toBe(409);
        const [after] = await getTestDb()
          .select({ siteId: devices.siteId, status: devices.status })
          .from(devices)
          .where(and(eq(devices.id, fx.allowed.id), eq(devices.orgId, fx.org.id)));
        expect(after).toMatchObject({ siteId: fx.secondAllowedSite.id, status: 'quarantined' });
        expect(issueMtlsCertForDeviceMock).not.toHaveBeenCalled();
        expect(terminateDeviceRemoteSessionsMock).not.toHaveBeenCalled();
        expect(writeAuditEventMock).not.toHaveBeenCalled();
      } catch (error) {
        primaryFailed = true;
        throw error;
      } finally {
        releaseLock();
        await started.drain(primaryFailed);
      }
    },
  );
});
