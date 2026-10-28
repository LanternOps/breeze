/**
 * #8971: once the end user's device withdraws a pending elevation, neither
 * real approval path can approve it, and a respond that races the withdraw
 * names the status that won.
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
import { withdrawElevationRequest } from '../../services/pamWithdraw';
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
      email: `${label}-${randomUUID()}@withdraw8971.test`,
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
        agentId: `agent-8971-${randomUUID()}`,
        hostname: `ws-8971-${randomUUID().slice(0, 8)}`,
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

async function withdraw(s: Scenario, elevationId: string) {
  return withDbAccessContext(agentContext(s), () =>
    withdrawElevationRequest({
      orgId: s.orgId,
      deviceId: s.deviceId,
      requestId: elevationId,
      reason: 'user_denied',
      agentDeclinedAt: null,
    }),
  );
}

// Lock barrier helpers, as in elevationApprovalConcurrency.integration.test.ts.
async function holdOpen(
  statement: (tx: postgres.TransactionSql) => Promise<unknown>,
): Promise<{ pid: number; release: () => Promise<void> }> {
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
  let reportPid!: (pid: number) => void;
  const pidReady = new Promise<number>((resolve) => { reportPid = resolve; });
  const done = adminSql.begin(async (tx) => {
    const [row] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    await statement(tx);
    reportPid(row!.pid);
    await gate;
  });
  const pid = await Promise.race([
    pidReady,
    done.then(() => { throw new Error('holder transaction ended before it reported its pid'); }),
  ]);
  return {
    pid,
    release: async () => {
      releaseGate();
      await done;
    },
  };
}

/** Backends waiting, directly or behind another waiter, on a lock holderPid holds. */
async function blockedBy(holderPid: number): Promise<number> {
  const [row] = await adminSql<{ n: number }[]>`
    WITH RECURSIVE waiters(pid) AS (
      SELECT a.pid FROM pg_stat_activity a WHERE ${holderPid} = ANY(pg_blocking_pids(a.pid))
      UNION
      SELECT a.pid FROM pg_stat_activity a JOIN waiters w ON w.pid = ANY(pg_blocking_pids(a.pid))
    )
    SELECT count(*)::int AS n FROM waiters
  `;
  return row!.n;
}

async function waitUntil(label: string, check: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for: ${label}`);
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

describe.skipIf(!RUN)('withdrawn elevations cannot be approved (#8971)', () => {
  it('positive control: the harness approves a pending request on the web', async () => {
    const s = await seedScenario();
    const { elevationId } = await seedElevation(s, [s.approverA]);

    const res = await respondOnWeb(s, elevationId);

    expect(res.status).toBe(200);
    expect((await statuses(elevationId, [])).elevation.status).toBe('approved');
  });

  it('positive control: the harness approves a pending request from a phone', async () => {
    const s = await seedScenario();
    const { elevationId, approvalIds } = await seedElevation(s, [s.approverA]);

    const res = await decide(s, s.approverA, approvalIds[0]!, 'approve');

    expect(res.status).toBe(200);
    expect((await statuses(elevationId, approvalIds)).elevation.status).toBe('approved');
  });

  it('the web console respond route refuses a withdrawn request and names it', async () => {
    const s = await seedScenario();
    const { elevationId } = await seedElevation(s, [s.approverA]);
    expect(await withdraw(s, elevationId)).toMatchObject({ kind: 'withdrawn', replay: false });

    const res = await respondOnWeb(s, elevationId);

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ success: false, currentStatus: 'withdrawn' });
    const after = await statuses(elevationId, []);
    expect(after.elevation.status).toBe('withdrawn');
    expect(after.elevation.approvedBy).toBeNull();
  });

  // The elevation is held so both writers are queued on it before either can
  // run; the queue order is fixed, so each case has one correct outcome. In
  // the withdraw-first case the respond route read 'pending' before the
  // withdraw committed, so its 409 must come from the post-CAS re-read.
  it.each(['withdraw', 'approval'] as const)('a withdraw and a web approval queued together: %s first wins cleanly', async (first) => {
    const s = await seedScenario();
    const { elevationId } = await seedElevation(s, [s.approverA]);

    const holder = await holdOpen((tx) => tx`SELECT id FROM elevation_requests WHERE id = ${elevationId} FOR UPDATE`);
    let withdrawP!: ReturnType<typeof withdraw>;
    let approvalP!: Promise<Response>;
    try {
      if (first === 'withdraw') {
        withdrawP = withdraw(s, elevationId);
        withdrawP.catch(() => {});
        await waitUntil('withdraw waiting on the elevation', async () => (await blockedBy(holder.pid)) >= 1);
        approvalP = respondOnWeb(s, elevationId);
      } else {
        approvalP = respondOnWeb(s, elevationId);
        approvalP.catch(() => {});
        await waitUntil('approval waiting on the elevation', async () => (await blockedBy(holder.pid)) >= 1);
        withdrawP = withdraw(s, elevationId);
      }
      withdrawP.catch(() => {});
      approvalP.catch(() => {});
      await waitUntil('withdraw and approval both waiting on the elevation', async () => (await blockedBy(holder.pid)) >= 2);
    } finally {
      await holder.release();
    }
    const [withdrawn, approval] = await Promise.all([withdrawP, approvalP]);

    const [row] = await withSystemDbAccessContext(() =>
      db.select().from(elevationRequests).where(eq(elevationRequests.id, elevationId)),
    );
    if (first === 'withdraw') {
      expect(withdrawn).toMatchObject({ kind: 'withdrawn', replay: false });
      expect(row!.status).toBe('withdrawn');
      expect(row!.approvedByUserId).toBeNull();
      expect(approval.status).toBe(409);
      await expect(approval.json()).resolves.toMatchObject({ currentStatus: 'withdrawn' });
    } else {
      expect(approval.status).toBe(200);
      expect(withdrawn).toEqual({ kind: 'not_pending', status: 'approved' });
      expect(row!.status).toBe('approved');
      expect(row!.withdrawnAt).toBeNull();
      expect(row!.approvedByUserId).toBe(s.webDecider.id);
    }
  });

  it('a phone approval of a withdrawn request loses the race and expires', async () => {
    const s = await seedScenario();
    const { elevationId, approvalIds } = await seedElevation(s, [s.approverA, s.approverB]);
    await withdraw(s, elevationId);
    // Deliberately do NOT run expireSupersededMobileApprovals: the decide
    // path's own elevation lock must refuse the approve even if the route's
    // post-exit expiry never ran.

    const res = await decide(s, s.approverA, approvalIds[0]!, 'approve');

    expect(res.status).toBe(409);
    const after = await statuses(elevationId, approvalIds);
    expect(after.elevation.status).toBe('withdrawn');
    expect(after.elevation.approvedBy).toBeNull();
    expect(after.approvals.get(approvalIds[0]!)).toBe('expired');
    expect(after.approvals.get(approvalIds[1]!)).toBe('pending');
    expect(await expireSupersededMobileApprovals(elevationId)).toBe(1);
    expect((await statuses(elevationId, approvalIds)).approvals.get(approvalIds[1]!)).toBe('expired');
  });
});
