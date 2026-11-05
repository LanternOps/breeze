/**
 * Real-Postgres proof for the PAM outcome notice (#8928).
 *
 * When an end user hands an elevation request to IT and it is then denied or
 * expires, the server queues one `pam_request_notify` command for that device,
 * on the deciding transaction, as `breeze_app`:
 *
 *   - a technician's deny (the approvals decide path) on a capable device
 *     commits with exactly one notice carrying the sanitized reason;
 *   - an incapable device (capability 0) gets no notice, and the deny commits;
 *   - a refused approve (unverifiable hash) leaves the user waiting, so it
 *     queues a "denied" notice with the user-facing wording;
 *   - a parked device refuses the insert, and the enclosing transaction is
 *     still usable and commits (the savepoint is what makes that true);
 *   - the stale-pending expiry job queues one "expired" notice per expired
 *     request, on capable devices only.
 */
import './setup';
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { db, withSystemDbAccessContext } from '../../db';
import { approvalRequests } from '../../db/schema/approvals';
import { elevationRequests } from '../../db/schema/elevations';
import { deviceCommands, devices } from '../../db/schema';
import { PERMISSIONS } from '../../services/permissions';
import { createAccessToken, type TokenPayload } from '../../services/jwt';
import { enqueuePamRequestNotify } from '../../services/pamRequestNotify';
import { expireStaleRequests } from '../../jobs/pamJobs';
import { approvalRoutes } from '../../routes/approvals';
import { currentOwnershipEpochSql } from '../../services/deviceOwnershipEpoch';
import {
  assignUserToOrganization,
  createOrganization,
  createPartner,
  createRole,
  createSite,
  createUser,
  grantRolePermissions,
} from './db-utils';
import { getTestDb } from './setup';
import { seedHoldingOrg, seedParkedDevice } from './unassignedPoolFixtures';

const RUN = !!process.env.DATABASE_URL;
const VALID_HASH = 'a'.repeat(64);

interface Scenario {
  partnerId: string;
  orgId: string;
  siteId: string;
  approver: { id: string; email: string };
  roleId: string;
}

async function seedScenario(): Promise<Scenario> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const role = await createRole({ scope: 'organization', orgId: org.id });
  await grantRolePermissions(role.id, [PERMISSIONS.PAM_APPROVE, PERMISSIONS.DEVICES_EXECUTE]);
  const approver = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `approver-${randomUUID()}@pamnotify.test`,
  });
  await assignUserToOrganization(approver.id, org.id, role.id);
  return {
    partnerId: partner.id,
    orgId: org.id,
    siteId: site.id,
    approver: { id: approver.id, email: approver.email },
    roleId: role.id,
  };
}

async function seedDevice(s: Scenario, capability: 0 | 1): Promise<string> {
  const [device] = await withSystemDbAccessContext(() =>
    db
      .insert(devices)
      .values({
        orgId: s.orgId,
        siteId: s.siteId,
        agentId: `agent-notify-${randomUUID()}`,
        hostname: `ws-notify-${randomUUID().slice(0, 8)}`,
        osType: 'windows',
        osVersion: '10.0',
        architecture: 'amd64',
        agentVersion: '1.0.0',
        status: 'online',
        pamUserNotifyProtocolVersion: capability,
      })
      .returning({ id: devices.id }),
  );
  return device!.id;
}

async function seedPendingElevation(
  s: Scenario,
  deviceId: string,
  opts: { hash?: string | null; requestedAt?: Date; withApproval?: boolean } = {},
): Promise<{ elevationId: string; approvalId: string | null }> {
  return withSystemDbAccessContext(async () => {
    const [elev] = await db
      .insert(elevationRequests)
      .values({
        orgId: s.orgId,
        siteId: s.siteId,
        partnerId: s.partnerId,
        deviceId,
        deviceEpoch: currentOwnershipEpochSql(deviceId),
        flowType: 'uac_intercept',
        subjectUsername: 'NOTIFY\\enduser',
        reason: 'install setup.exe',
        targetExecutablePath: 'C:\\Temp\\setup.exe',
        targetExecutableHash: opts.hash === undefined ? VALID_HASH : opts.hash,
        status: 'pending',
        ...(opts.requestedAt ? { requestedAt: opts.requestedAt } : {}),
      })
      .returning({ id: elevationRequests.id });
    if (opts.withApproval === false) return { elevationId: elev!.id, approvalId: null };
    const [approval] = await db
      .insert(approvalRequests)
      .values({
        userId: s.approver.id,
        requestingClientLabel: 'Breeze Agent',
        actionLabel: 'Elevate setup.exe',
        actionToolName: 'uac_intercept',
        riskTier: 'low',
        riskSummary: 'admin requested',
        status: 'pending',
        expiresAt: new Date(Date.now() + 5 * 60_000),
        elevationRequestId: elev!.id,
      })
      .returning({ id: approvalRequests.id });
    return { elevationId: elev!.id, approvalId: approval!.id };
  });
}

async function decide(s: Scenario, approvalId: string, action: 'approve' | 'deny', reason?: string) {
  const payload: Omit<TokenPayload, 'type'> = {
    sub: s.approver.id,
    email: s.approver.email,
    roleId: s.roleId,
    orgId: s.orgId,
    partnerId: s.partnerId,
    scope: 'organization',
    mfa: true,
    aep: 1,
    mep: 1,
    sid: randomUUID(),
  };
  const token = await createAccessToken(payload);
  const app = new Hono();
  app.route('/approvals', approvalRoutes);
  return app.request(`/approvals/${approvalId}/${action}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(reason === undefined ? {} : { reason }),
  });
}

async function notices(deviceId: string) {
  return getTestDb()
    .select()
    .from(deviceCommands)
    .where(and(eq(deviceCommands.deviceId, deviceId), eq(deviceCommands.type, 'pam_request_notify')));
}

async function elevationStatus(id: string): Promise<string> {
  const [row] = await getTestDb()
    .select({ status: elevationRequests.status })
    .from(elevationRequests)
    .where(eq(elevationRequests.id, id));
  return row!.status;
}

let s: Scenario;

beforeEach(async () => {
  s = await seedScenario();
});

describe.skipIf(!RUN)('pam_request_notify enqueue (real Postgres, breeze_app)', () => {
  it('a technician deny on a capable device commits with exactly one denied notice', async () => {
    const deviceId = await seedDevice(s, 1);
    const { elevationId, approvalId } = await seedPendingElevation(s, deviceId);

    const before = Date.now();
    const res = await decide(s, approvalId!, 'deny', 'Use the portal copy\r\n\r\n\r\nThanks');
    expect(res.status).toBe(200);
    expect(await elevationStatus(elevationId)).toBe('denied');

    const rows = await notices(deviceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'pending',
      targetRole: 'agent',
      createdBy: null,
      submittedOrgId: s.orgId,
      payload: { requestId: elevationId, outcome: 'denied', reason: 'Use the portal copy\n\nThanks' },
    });
    // #10190 W07: the approver's name, resolved in the deciding context at the
    // device's technician_identity_level (no remote_access policy -> the
    // name_email default), never the email.
    expect(rows[0]!.payload).toMatchObject({ decidedBy: { technicianName: 'Test User' } });
    expect(JSON.stringify(rows[0]!.payload)).not.toContain(s.approver.email);
    const deliverBy = rows[0]!.deliverBy!.getTime();
    expect(deliverBy).toBeGreaterThanOrEqual(before + 59 * 60_000);
    expect(deliverBy).toBeLessThanOrEqual(Date.now() + 61 * 60_000);
  });

  it('a deny on an incapable device commits with no notice', async () => {
    const deviceId = await seedDevice(s, 0);
    const { elevationId, approvalId } = await seedPendingElevation(s, deviceId);
    expect((await decide(s, approvalId!, 'deny', 'no')).status).toBe(200);
    expect(await elevationStatus(elevationId)).toBe('denied');
    expect(await notices(deviceId)).toHaveLength(0);
  });

  it('an approve does not notify', async () => {
    const deviceId = await seedDevice(s, 1);
    const { approvalId } = await seedPendingElevation(s, deviceId);
    expect((await decide(s, approvalId!, 'approve')).status).toBe(200);
    expect(await notices(deviceId)).toHaveLength(0);
  });

  it('a refused approve (unverifiable hash) tells the waiting user it was denied, in user-facing words', async () => {
    const deviceId = await seedDevice(s, 1);
    const { elevationId, approvalId } = await seedPendingElevation(s, deviceId, { hash: null });
    const res = await decide(s, approvalId!, 'approve');
    expect(res.status).toBe(200);
    expect((await res.json()).enforcementStatus).toBe('refused');
    const rows = await notices(deviceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toEqual({
      requestId: elevationId,
      outcome: 'denied',
      reason: 'The program could not be verified.',
      // #10190 W07: the system refused it, no technician decided.
      decidedBy: { technicianName: null },
    });
  });

  it('parked device: the refused insert is swallowed and the enclosing transaction still commits', async () => {
    const pool = await seedHoldingOrg(s.partnerId);
    const parked = await seedParkedDevice(pool.orgId, pool.siteId);
    await getTestDb()
      .update(devices)
      .set({ pamUserNotifyProtocolVersion: 1 })
      .where(eq(devices.id, parked.id));
    const marker = `parked-${randomUUID()}`;

    const outcome = await withSystemDbAccessContext(() =>
      db.transaction(async (tx) => {
        const result = await enqueuePamRequestNotify(tx, { id: randomUUID(), deviceId: parked.id }, 'denied', 'x');
        // The caller's transaction is still usable after the refusal: a later
        // statement runs and the whole transaction commits.
        await tx.update(devices).set({ hostname: marker }).where(eq(devices.id, parked.id));
        return result;
      }),
    );

    expect(outcome).toBe('skipped');
    expect(await notices(parked.id)).toHaveLength(0);
    const [row] = await getTestDb()
      .select({ hostname: devices.hostname })
      .from(devices)
      .where(eq(devices.id, parked.id));
    expect(row!.hostname).toBe(marker);
  });

  it('the stale-pending expiry job queues one expired notice per expired request on capable devices only', async () => {
    const capable = await seedDevice(s, 1);
    const incapable = await seedDevice(s, 0);
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    const a = await seedPendingElevation(s, capable, { requestedAt: old, withApproval: false });
    const b = await seedPendingElevation(s, incapable, { requestedAt: old, withApproval: false });
    const fresh = await seedPendingElevation(s, capable, { withApproval: false });

    await withSystemDbAccessContext(() => expireStaleRequests());

    expect(await elevationStatus(a.elevationId)).toBe('expired');
    expect(await elevationStatus(b.elevationId)).toBe('expired');
    expect(await elevationStatus(fresh.elevationId)).toBe('pending');
    const rows = await notices(capable);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toEqual({ requestId: a.elevationId, outcome: 'expired', decidedBy: { technicianName: null } });
    expect(await notices(incapable)).toHaveLength(0);
  });
});
