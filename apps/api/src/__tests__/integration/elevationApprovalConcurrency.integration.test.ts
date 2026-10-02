/**
 * Real-Postgres proof of the elevation approval lock order (#7526).
 *
 * One pending uac_intercept elevation fans out to one approval_requests row
 * per approver. Two paths decide it:
 *
 *   - the approvals inbox / mobile app (`POST /approvals/:id/approve|deny`,
 *     decideApprovalRequest), which decides the approver's own row and mirrors
 *     the decision onto the elevation, then expires the sibling rows;
 *   - the web console (`POST /pam/elevation-requests/:id/respond`), which
 *     decides the elevation and then expires every still-pending row.
 *
 * The tests hold a lock from a separate connection to force the interleaving
 * each problem needs, so they do not depend on timing:
 *
 *   1. two approvers deciding the same elevation at once: neither fails with a
 *      Postgres deadlock; one wins and the other gets a 409;
 *   2. the web decision's sibling expiry runs after the request transaction
 *      has committed, so it never waits on an approval row while the
 *      elevation is still locked;
 *   3. an approve or deny whose elevation was already decided elsewhere is
 *      not stored as decided: the row is expired and the caller gets a 409.
 *
 * Drives the real routes (real JWT + authMiddleware + breeze_app RLS).
 */
import './setup';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
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
  await grantRolePermissions(role.id, [PERMISSIONS.PAM_APPROVE]);
  const approver = async (label: string): Promise<Approver> => {
    const user = await createUser({
      partnerId: partner.id,
      orgId: org.id,
      email: `${label}-${randomUUID()}@elevationconcurrency.test`,
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
        agentId: `agent-concurrency-${randomUUID()}`,
        hostname: `ws-concurrency-${randomUUID().slice(0, 8)}`,
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
        flowType: 'uac_intercept',
        subjectUsername: 'CONCURRENCY\\enduser',
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

/**
 * Runs `statement` in a transaction on its own connection and keeps that
 * transaction open (holding whatever locks the statement took) until
 * `release()` commits it.
 */
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

/**
 * Number of backends waiting, directly or through another waiter, on a lock
 * the backend `holderPid` holds. A second waiter on a row queues behind the
 * first waiter's tuple lock, so it is blocked by that waiter, not the holder.
 */
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

async function waitUntil(label: string, check: () => Promise<boolean> | boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

/** Tracks whether a promise has settled, without consuming its rejection. */
function track<T>(p: Promise<T>): { promise: Promise<T>; settled: () => boolean } {
  let settled = false;
  p.then(() => { settled = true; }, () => { settled = true; });
  return { promise: p, settled: () => settled };
}

async function readApprovals(ids: string[]) {
  const rows = await withSystemDbAccessContext(() =>
    db
      .select({ id: approvalRequests.id, status: approvalRequests.status })
      .from(approvalRequests)
      .where(inArray(approvalRequests.id, ids)),
  );
  return new Map(rows.map((r) => [r.id, r.status]));
}

async function readElevation(id: string) {
  const [row] = await withSystemDbAccessContext(() =>
    db
      .select({
        status: elevationRequests.status,
        approvedByUserId: elevationRequests.approvedByUserId,
        deniedByUserId: elevationRequests.deniedByUserId,
      })
      .from(elevationRequests)
      .where(eq(elevationRequests.id, id)),
  );
  return row!;
}

let s: Scenario;

beforeEach(async () => {
  s = await seedScenario();
});

describe.skipIf(!RUN)('elevation approval lock order (#7526)', () => {
  it('two approvers deciding the same elevation at once do not deadlock: one wins, the other gets a 409', async () => {
    const { elevationId, approvalIds } = await seedElevation(s, [s.approverA, s.approverB]);
    const [rowA, rowB] = approvalIds as [string, string];

    // Hold the elevation so both decides get as far as it and queue there,
    // then let them go together.
    const holder = await holdOpen((tx) => tx`SELECT id FROM elevation_requests WHERE id = ${elevationId} FOR UPDATE`);
    const a = track(decide(s, s.approverA, rowA, 'approve'));
    const b = track(decide(s, s.approverB, rowB, 'approve'));
    try {
      await waitUntil('both decides waiting on the elevation', async () => (await blockedBy(holder.pid)) >= 2);
    } finally {
      await holder.release();
    }
    const [resA, resB] = await Promise.all([a.promise, b.promise]);

    // Before the fix each decide held its own approval row and waited for the
    // elevation, and the winner then waited for the loser's row in the sibling
    // expiry: Postgres aborted one with 40P01 and the route returned 500.
    expect([resA.status, resB.status].sort()).toEqual([200, 409]);
    const [winnerUser, winnerRow, loserRow] = resA.status === 200
      ? [s.approverA, rowA, rowB]
      : [s.approverB, rowB, rowA];

    const rows = await readApprovals([rowA, rowB]);
    expect(rows.get(winnerRow)).toBe('approved');
    expect(rows.get(loserRow)).toBe('expired');
    expect(await readElevation(elevationId)).toMatchObject({
      status: 'approved',
      approvedByUserId: winnerUser.id,
    });
  });

  it('the web decision expires the sibling rows after its transaction commits, not while the elevation is locked', async () => {
    const { elevationId, approvalIds } = await seedElevation(s, [s.approverA, s.approverB]);
    const [rowA, rowB] = approvalIds as [string, string];

    // Another transaction holds approver A's row, as an approvals-inbox decide
    // on it would. The web decision's sibling expiry has to wait for it.
    const holder = await holdOpen((tx) => tx`SELECT id FROM approval_requests WHERE id = ${rowA} FOR UPDATE`);
    const web = track(respondOnWeb(s, elevationId));
    let probe: string;
    try {
      // Either the request finished (the expiry no longer holds it up) or it
      // is stuck behind A's row.
      await waitUntil('web respond finished or blocked', async () => web.settled() || (await blockedBy(holder.pid)) >= 1);
      // Is the elevation still locked at this point?
      probe = await adminSql
        .begin((tx) => tx`SELECT id FROM elevation_requests WHERE id = ${elevationId} FOR UPDATE NOWAIT`)
        .then(() => 'unlocked', (err: { code?: string }) => `locked (${err.code})`);
    } finally {
      await holder.release();
    }
    const res = await web.promise;
    expect(res.status).toBe(200);

    // Before the fix the expiry ran on a second connection while the request
    // transaction still held the elevation (55P03 here) — and a decide holding
    // A's row and waiting for the elevation then waited on a request that was
    // waiting on it, which Postgres cannot detect.
    expect(probe).toBe('unlocked');

    // The expiry still runs once A's row is free.
    await waitUntil('sibling rows expired', async () => {
      const rows = await readApprovals([rowA, rowB]);
      return rows.get(rowA) === 'expired' && rows.get(rowB) === 'expired';
    });
    expect(await readElevation(elevationId)).toMatchObject({
      status: 'approved',
      approvedByUserId: s.webDecider.id,
    });
  });

  it.each(['approve', 'deny'] as const)(
    'a %s that loses the race to a decision made elsewhere is stored as expired, not decided',
    async (decision) => {
      const { elevationId, approvalIds } = await seedElevation(s, [s.approverA]);
      const [rowA] = approvalIds as [string];

      // The web console is deciding the elevation and has not committed yet.
      const holder = await holdOpen((tx) => tx`
        UPDATE elevation_requests
        SET status = 'approved', approved_by_user_id = ${s.webDecider.id},
            approved_at = now(), expires_at = now() + interval '30 minutes', updated_at = now()
        WHERE id = ${elevationId}
      `);
      const res = track(decide(s, s.approverA, rowA, decision));
      try {
        await waitUntil('decide waiting on the elevation', async () => (await blockedBy(holder.pid)) >= 1);
      } finally {
        await holder.release();
      }
      const response = await res.promise;

      // Before the fix the approval row committed as decided even though the
      // elevation update matched nothing, and the route returned 200.
      expect(response.status).toBe(409);
      expect((await readApprovals([rowA])).get(rowA)).toBe('expired');
      expect(await readElevation(elevationId)).toMatchObject({
        status: 'approved',
        approvedByUserId: s.webDecider.id,
        deniedByUserId: null,
      });
    },
  );

  it('an approve on a row whose elevation was already closed (no sibling expiry ran) is stored as expired', async () => {
    const { elevationId, approvalIds } = await seedElevation(s, [s.approverA]);
    const [rowA] = approvalIds as [string];
    // The stale-request expirer closes a pending elevation without touching
    // its approval rows.
    await withSystemDbAccessContext(() =>
      db
        .update(elevationRequests)
        .set({ status: 'expired', expiredAt: new Date(), updatedAt: new Date() })
        .where(eq(elevationRequests.id, elevationId)),
    );

    const res = await decide(s, s.approverA, rowA, 'approve');
    expect(res.status).toBe(409);
    expect((await readApprovals([rowA])).get(rowA)).toBe('expired');
    expect((await readElevation(elevationId)).status).toBe('expired');
  });

  describe('the web decision\'s deferred sibling expiry', () => {
    it('leaves the rows pending while the elevation is still pending (the request rolled back)', async () => {
      const { elevationId, approvalIds } = await seedElevation(s, [s.approverA, s.approverB]);

      expect(await expireSupersededMobileApprovals(elevationId)).toBe(0);
      const rows = await readApprovals(approvalIds);
      expect([...rows.values()]).toEqual(['pending', 'pending']);
    });

    it('expires the pending rows once the elevation has been decided', async () => {
      const { elevationId, approvalIds } = await seedElevation(s, [s.approverA, s.approverB]);
      const [rowA, rowB] = approvalIds as [string, string];
      // Approver A's row was already decided; only pending rows move.
      await withSystemDbAccessContext(() =>
        db
          .update(approvalRequests)
          .set({ status: 'denied', decidedAt: new Date() })
          .where(eq(approvalRequests.id, rowA)),
      );
      await withSystemDbAccessContext(() =>
        db
          .update(elevationRequests)
          .set({ status: 'denied', deniedByUserId: s.webDecider.id, denialReason: 'no', updatedAt: new Date() })
          .where(eq(elevationRequests.id, elevationId)),
      );

      expect(await expireSupersededMobileApprovals(elevationId)).toBe(1);
      const rows = await readApprovals(approvalIds);
      expect(rows.get(rowA)).toBe('denied');
      expect(rows.get(rowB)).toBe('expired');
    });
  });
});
