/**
 * #9517: once the agent reports it cannot act on a pending elevation, neither
 * real approval path can approve it.
 *
 *   - web console: POST /pam/elevation-requests/:id/respond (routes/pam.ts)
 *   - approvals inbox / mobile app: POST /approvals/:id/approve
 *     (decideApprovalRequest)
 *
 * Drives the real routes (real JWT + authMiddleware + breeze_app RLS), with a
 * positive control proving the same harness approves an unreported request.
 * Seeding and token helpers mirror elevationApprovalConcurrency.integration.test.ts.
 */
import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import postgres from 'postgres';
import { eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { db, withSystemDbAccessContext } from '../../db';
import { approvalRequests } from '../../db/schema/approvals';
import { elevationRequests } from '../../db/schema/elevations';
import { devices } from '../../db/schema';
import { PERMISSIONS } from '../../services/permissions';
import { createAccessToken, type TokenPayload } from '../../services/jwt';
import {
  assignUserToOrganization,
  createOrganization,
  createPartner,
  createRole,
  createSite,
  createUser,
  grantRolePermissions,
} from './db-utils';
import { approvalRoutes } from '../../routes/approvals';
import { pamRoutes } from '../../routes/pam';
import { expireSupersededMobileApprovals } from '../../services/pamMobileApprovals';
import { withDbAccessContext } from '../../db';
import { recordElevationDeviceUnable } from '../../services/pamDeviceUnable';
import { currentOwnershipEpochSql } from '../../services/deviceOwnershipEpoch';

const RUN = !!process.env.DATABASE_URL;
// Superuser connections for the lock holder, the probe and the pg_stat_activity
// poll — each needs its own connection while the others are busy.
const adminSql = postgres(process.env.DATABASE_URL ?? '', { max: 4 });
afterAll(async () => { await adminSql.end({ timeout: 5 }); });

const VALID_HASH = 'a'.repeat(64);

interface Approver {
  id: string;
  email: string;
}

interface Scenario {
  partnerId: string;
  orgId: string;
  siteId: string;
  deviceId: string;
  roleId: string;
  approverA: Approver;
  approverB: Approver;
  webDecider: Approver;
}

async function seedScenario(): Promise<Scenario> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const role = await createRole({ scope: 'organization', orgId: org.id });
  // A UAC approval needs both the PAM decision and the device execution grant.
  await grantRolePermissions(role.id, [PERMISSIONS.PAM_APPROVE, PERMISSIONS.DEVICES_EXECUTE]);
  const approver = async (label: string): Promise<Approver> => {
    const user = await createUser({
      partnerId: partner.id,
      orgId: org.id,
      email: `${label}-${randomUUID()}@deviceunable9517.test`,
    });
    await assignUserToOrganization(user.id, org.id, role.id);
    return { id: user.id, email: user.email };
  };
  const [device] = await withSystemDbAccessContext(() =>
    db
      .insert(devices)
      .values({
        orgId: org.id,
        siteId: site.id,
        agentId: `agent-9517-${randomUUID()}`,
        hostname: `rds-9517-${randomUUID().slice(0, 8)}`,
        osType: 'windows',
        osVersion: '10.0',
        architecture: 'amd64',
        agentVersion: '1.0.0',
        status: 'online',
      })
      .returning({ id: devices.id }),
  );
  return {
    partnerId: partner.id,
    orgId: org.id,
    siteId: site.id,
    deviceId: device!.id,
    roleId: role.id,
    approverA: await approver('approver-a'),
    approverB: await approver('approver-b'),
    webDecider: await approver('web-decider'),
  };
}

/** A pending uac_intercept elevation fanned out as one pending row per approver. */
async function seedElevation(
  s: Scenario,
  approvers: Approver[],
): Promise<{ elevationId: string; approvalIds: string[] }> {
  return withSystemDbAccessContext(async () => {
    const [elev] = await db
      .insert(elevationRequests)
      .values({
        orgId: s.orgId,
        siteId: s.siteId,
        partnerId: s.partnerId,
        deviceId: s.deviceId,
        deviceEpoch: currentOwnershipEpochSql(s.deviceId),
        flowType: 'uac_intercept',
        subjectUsername: 'RDS\\enduser',
        reason: 'install setup.exe',
        targetExecutablePath: 'C:\\Temp\\setup.exe',
        targetExecutableHash: VALID_HASH,
        // Low tier: a session tap (L1) meets the floor on both decide paths.
        riskTier: 1,
        status: 'pending',
      })
      .returning({ id: elevationRequests.id });
    const rows = await db
      .insert(approvalRequests)
      .values(approvers.map((a) => ({
        userId: a.id,
        requestingClientLabel: 'Breeze Agent',
        actionLabel: 'Elevate setup.exe',
        actionToolName: 'uac_intercept',
        riskTier: 'low' as const,
        riskSummary: 'admin requested',
        status: 'pending' as const,
        expiresAt: new Date(Date.now() + 5 * 60_000),
        elevationRequestId: elev!.id,
      })))
      .returning({ id: approvalRequests.id, userId: approvalRequests.userId });
    const byUser = new Map(rows.map((r) => [r.userId, r.id]));
    return { elevationId: elev!.id, approvalIds: approvers.map((a) => byUser.get(a.id)!) };
  });
}

async function tokenFor(s: Scenario, user: Approver): Promise<string> {
  const payload: Omit<TokenPayload, 'type'> = {
    sub: user.id,
    email: user.email,
    roleId: s.roleId,
    orgId: s.orgId,
    partnerId: s.partnerId,
    scope: 'organization',
    // The PAM respond route sits behind requireMfa().
    mfa: true,
    aep: 1,
    mep: 1,
    sid: randomUUID(),
  };
  return createAccessToken(payload);
}

function app(): Hono {
  const a = new Hono();
  a.route('/approvals', approvalRoutes);
  a.route('/pam', pamRoutes);
  return a;
}

async function decide(
  s: Scenario,
  user: Approver,
  approvalId: string,
  decision: 'approve' | 'deny',
): Promise<Response> {
  const token = await tokenFor(s, user);
  return app().request(`/approvals/${approvalId}/${decision}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(decision === 'deny' ? { reason: 'no' } : {}),
  });
}

async function respondOnWeb(s: Scenario, elevationId: string): Promise<Response> {
  const token = await tokenFor(s, s.webDecider);
  return app().request(`/pam/elevation-requests/${elevationId}/respond`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision: 'approve' }),
  });
}


function agentContext(s: Scenario) {
  return {
    scope: 'organization' as const,
    orgId: s.orgId,
    accessibleOrgIds: [s.orgId],
    accessiblePartnerIds: [],
    currentPartnerId: s.partnerId,
  };
}

async function reportUnable(s: Scenario, elevationId: string) {
  return withDbAccessContext(agentContext(s), () =>
    recordElevationDeviceUnable({
      deviceId: s.deviceId,
      elevationRequestId: elevationId,
      reason: 'session_unavailable',
      detail: 'session 3 cannot host a SYSTEM helper (not active or connected)',
    }),
  );
}

async function statuses(elevationId: string, approvalIds: string[]) {
  return withSystemDbAccessContext(async () => {
    const [elev] = await db.select({ status: elevationRequests.status, approvedBy: elevationRequests.approvedByUserId })
      .from(elevationRequests).where(eq(elevationRequests.id, elevationId));
    const approvals = await db.select({ id: approvalRequests.id, status: approvalRequests.status })
      .from(approvalRequests).where(inArray(approvalRequests.id, approvalIds));
    return { elevation: elev!, approvals: new Map(approvals.map((a) => [a.id, a.status])) };
  });
}

describe.skipIf(!RUN)('device-unable elevations cannot be approved (#9517)', () => {
  it('positive control: the harness approves an unreported request on the web', async () => {
    const s = await seedScenario();
    const { elevationId } = await seedElevation(s, [s.approverA]);

    const res = await respondOnWeb(s, elevationId);

    expect(res.status).toBe(200);
    expect((await statuses(elevationId, [])).elevation.status).toBe('approved');
  });

  it('positive control: the harness approves an unreported request from a phone', async () => {
    const s = await seedScenario();
    const { elevationId, approvalIds } = await seedElevation(s, [s.approverA]);

    const res = await decide(s, s.approverA, approvalIds[0]!, 'approve');

    expect(res.status).toBe(200);
    const after = await statuses(elevationId, approvalIds);
    expect(after.elevation.status).toBe('approved');
    expect(after.approvals.get(approvalIds[0]!)).toBe('approved');
  });

  it('the web console respond route refuses a request the device reported unable', async () => {
    const s = await seedScenario();
    const { elevationId } = await seedElevation(s, [s.approverA]);
    expect(await reportUnable(s, elevationId)).toMatchObject({ kind: 'recorded', closed: true });

    const res = await respondOnWeb(s, elevationId);

    expect(res.status).toBe(409);
    const after = await statuses(elevationId, []);
    expect(after.elevation.status).toBe('expired');
    expect(after.elevation.approvedBy).toBeNull();
  });

  it('a phone approval of a request the device reported unable loses the race and expires', async () => {
    const s = await seedScenario();
    const { elevationId, approvalIds } = await seedElevation(s, [s.approverA, s.approverB]);
    await reportUnable(s, elevationId);
    // Deliberately do NOT run expireSupersededMobileApprovals: the decide
    // path's own elevation lock must refuse the approve even if the
    // withdrawal never ran.

    const res = await decide(s, s.approverA, approvalIds[0]!, 'approve');

    expect(res.status).toBe(409);
    const after = await statuses(elevationId, approvalIds);
    expect(after.elevation.status).toBe('expired');
    expect(after.elevation.approvedBy).toBeNull();
    expect(after.approvals.get(approvalIds[0]!)).toBe('expired');
    // The other approver's row is still pending until the withdrawal runs.
    expect(after.approvals.get(approvalIds[1]!)).toBe('pending');
    expect(await expireSupersededMobileApprovals(elevationId)).toBe(1);
    expect((await statuses(elevationId, approvalIds)).approvals.get(approvalIds[1]!)).toBe('expired');
  });
});
