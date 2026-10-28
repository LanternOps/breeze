/**
 * #8971 A2: the agent's withdraw of a pending elevation, against a real
 * Postgres as the unprivileged breeze_app role (RLS enforced).
 *
 * Service level: pending -> withdrawn with one audit row, idempotent replay,
 * ownership (device, org, flow), non-pending outcomes, and the race with the
 * technician's respond CAS on two separate pooled connections.
 * Route level: the HTTP request an agent sends, through agentRoutes and
 * agentAuthMiddleware (token lookup, path agent check, the request-long
 * org-scoped context the route relies on), including the post-exit expiry of
 * linked phone approvals.
 *
 * Run:
 *   pnpm test-stack up
 *   cd apps/api && npx vitest run -c vitest.integration.config.ts \
 *     src/__tests__/integration/pamElevationWithdraw.integration.test.ts
 */
import './setup';

import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { db, withDbAccessContext } from '../../db';
import { approvalRequests } from '../../db/schema/approvals';
import { devices, users } from '../../db/schema';
import { elevationAudit, elevationRequests } from '../../db/schema/elevations';
import { agentRoutes } from '../../routes/agents';
import { currentOwnershipEpochSql } from '../../services/deviceOwnershipEpoch';
import { expireUnactuatedElevationRequests } from '../../services/pamDeviceMoveGuard';
import { withdrawElevationRequest } from '../../services/pamWithdraw';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

type Agent = { orgId: string; siteId: string; partnerId: string; deviceId: string; agentId: string; token: string };

function agentContext(a: Pick<Agent, 'orgId' | 'partnerId'>) {
  return {
    scope: 'organization' as const,
    orgId: a.orgId,
    accessibleOrgIds: [a.orgId],
    accessiblePartnerIds: [],
    currentPartnerId: a.partnerId,
  };
}

async function seedAgent(tag: string, org?: { orgId: string; siteId: string; partnerId: string }): Promise<Agent> {
  const scope = org ?? await (async () => {
    const partner = await createPartner({ status: 'active' });
    const o = await createOrganization({ partnerId: partner.id, status: 'active' });
    const site = await createSite({ orgId: o.id });
    return { orgId: o.id, siteId: site.id, partnerId: partner.id };
  })();
  const suffix = randomUUID().slice(0, 8);
  const agentId = `agent-8971-${tag}-${suffix}`;
  const token = `brz_8971_${tag}_${suffix}`;
  const [device] = await getTestDb()
    .insert(devices)
    .values({
      orgId: scope.orgId,
      siteId: scope.siteId,
      agentId,
      hostname: `ws-8971-${tag}-${suffix}`,
      osType: 'windows',
      osVersion: '10.0',
      architecture: 'amd64',
      agentVersion: '1.0.0',
      status: 'online',
      agentTokenHash: createHash('sha256').update(token).digest('hex'),
      enrolledAt: new Date(),
    })
    .returning({ id: devices.id });
  return { ...scope, deviceId: device!.id, agentId, token };
}

async function seedRequest(
  a: Agent,
  opts: { flowType?: 'uac_intercept' | 'tech_jit_admin'; status?: 'pending' | 'approved'; subjectUserId?: string } = {},
): Promise<string> {
  const status = opts.status ?? 'pending';
  const [row] = await getTestDb()
    .insert(elevationRequests)
    .values({
      orgId: a.orgId,
      siteId: a.siteId,
      partnerId: a.partnerId,
      deviceId: a.deviceId,
      deviceEpoch: currentOwnershipEpochSql(a.deviceId),
      flowType: opts.flowType ?? 'uac_intercept',
      subjectUserId: opts.subjectUserId,
      subjectUsername: 'WS\\enduser',
      reason: 'UAC consent UI observed for C:\\Temp\\setup.exe',
      targetExecutablePath: 'C:\\Temp\\setup.exe',
      status,
      ...(status === 'approved' ? { approvedAt: new Date(), expiresAt: new Date(Date.now() + 15 * 60_000) } : {}),
    })
    .returning({ id: elevationRequests.id });
  return row!.id;
}

async function seedPhoneApprovals(a: Agent, elevationId: string): Promise<void> {
  const stamp = randomUUID().slice(0, 8);
  const approvers = await getTestDb().insert(users)
    .values([
      { partnerId: a.partnerId, email: `a-8971-${stamp}@example.test`, name: 'Approver A', status: 'active' },
      { partnerId: a.partnerId, email: `b-8971-${stamp}@example.test`, name: 'Approver B', status: 'active' },
    ])
    .returning({ id: users.id });
  await getTestDb()
    .insert(approvalRequests)
    .values(approvers.map((u) => ({
      userId: u.id,
      elevationRequestId: elevationId,
      requestingClientLabel: 'Breeze Agent',
      requestingMachineLabel: 'ws-8971',
      actionLabel: 'Elevate setup.exe',
      actionToolName: 'uac_intercept',
      actionArguments: {},
      riskTier: 'medium' as const,
      riskSummary: 'WS\\enduser requested admin to run setup.exe (unsigned).',
      status: 'pending' as const,
      isRecursive: false,
      expiresAt: new Date(Date.now() + 15 * 60_000),
    })));
}

async function readRequest(id: string) {
  const [row] = await getTestDb().select().from(elevationRequests).where(eq(elevationRequests.id, id));
  return row!;
}

async function readAudit(id: string) {
  return getTestDb()
    .select({ eventType: elevationAudit.eventType, actor: elevationAudit.actor, details: elevationAudit.details })
    .from(elevationAudit)
    .where(eq(elevationAudit.elevationRequestId, id))
    .orderBy(asc(elevationAudit.createdAt), asc(elevationAudit.id));
}

function withdraw(
  a: Agent,
  requestId: string,
  opts: { reason?: 'user_denied' | 'user_timeout' | 'dialog_error'; ctxAgent?: Agent; deviceId?: string; declinedAt?: Date | null } = {},
) {
  const ctxAgent = opts.ctxAgent ?? a;
  return withDbAccessContext(agentContext(ctxAgent), () =>
    withdrawElevationRequest({
      orgId: ctxAgent.orgId,
      deviceId: opts.deviceId ?? a.deviceId,
      requestId,
      reason: opts.reason ?? 'user_denied',
      agentDeclinedAt: opts.declinedAt === undefined ? new Date('2027-01-10T10:00:00.000Z') : opts.declinedAt,
    }),
  );
}

/** The respond route's CAS (routes/pam.ts): only a pending row is decided. */
function approveCas(tx: Pick<typeof db, 'update'>, id: string) {
  return tx.update(elevationRequests)
    .set({ status: 'approved', approvedAt: new Date(), expiresAt: new Date(Date.now() + 15 * 60_000), updatedAt: new Date() })
    .where(and(eq(elevationRequests.id, id), eq(elevationRequests.status, 'pending')))
    .returning({ id: elevationRequests.id });
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

/** Resolves to 'pending' if `p` has not settled within `ms`. */
async function settledWithin<T>(p: Promise<T>, ms: number): Promise<'settled' | 'pending'> {
  return Promise.race([p.then(() => 'settled' as const, () => 'settled' as const), new Promise<'pending'>((r) => setTimeout(() => r('pending'), ms))]);
}

describe('withdrawElevationRequest (#8971)', () => {
  let agent: Agent;

  beforeEach(async () => {
    agent = await seedAgent('a');
  });

  it('pending -> withdrawn: status, timestamp, reason and one end_user audit row', async () => {
    const id = await seedRequest(agent);

    const result = await withdraw(agent, id);

    expect(result).toMatchObject({ kind: 'withdrawn', replay: false });
    const row = await readRequest(id);
    expect(row.status).toBe('withdrawn');
    expect(row.withdrawnReason).toBe('user_denied');
    expect(row.withdrawnAt).toBeInstanceOf(Date);
    expect(result.kind === 'withdrawn' && result.withdrawnAt.getTime()).toBe(row.withdrawnAt!.getTime());
    expect(await readAudit(id)).toEqual([
      { eventType: 'withdrawn', actor: 'end_user', details: { cause: 'user_denied', agent_declined_at: '2027-01-10T10:00:00.000Z' } },
    ]);
  });

  it('records each reason, and a missing declinedAt as null', async () => {
    const timeout = await seedRequest(agent);
    const error = await seedRequest(agent);

    await withdraw(agent, timeout, { reason: 'user_timeout', declinedAt: null });
    await withdraw(agent, error, { reason: 'dialog_error' });

    expect((await readRequest(timeout)).withdrawnReason).toBe('user_timeout');
    expect((await readAudit(timeout))[0]?.details).toEqual({ cause: 'user_timeout', agent_declined_at: null });
    expect((await readRequest(error)).withdrawnReason).toBe('dialog_error');
  });

  it('replay is idempotent: same withdrawnAt, first reason kept, still one audit row', async () => {
    const id = await seedRequest(agent);
    const first = await withdraw(agent, id);

    const again = await withdraw(agent, id, { reason: 'user_timeout' });

    expect(again).toEqual({ kind: 'withdrawn', replay: true, withdrawnAt: first.kind === 'withdrawn' ? first.withdrawnAt : null });
    expect((await readRequest(id)).withdrawnReason).toBe('user_denied');
    expect(await readAudit(id)).toHaveLength(1);
  });

  it('approve-then-withdraw returns not_pending approved and leaves the approval alone', async () => {
    const id = await seedRequest(agent);
    expect(await withDbAccessContext(agentContext(agent), () => approveCas(db, id))).toHaveLength(1);

    const result = await withdraw(agent, id);

    expect(result).toEqual({ kind: 'not_pending', status: 'approved' });
    const row = await readRequest(id);
    expect(row.status).toBe('approved');
    expect(row.withdrawnAt).toBeNull();
    expect(await readAudit(id)).toHaveLength(0);
  });

  it('withdraw-then-approve: the respond CAS updates 0 rows', async () => {
    const id = await seedRequest(agent);
    await withdraw(agent, id);

    const approved = await withDbAccessContext(agentContext(agent), () => approveCas(db, id));

    expect(approved).toHaveLength(0);
    expect((await readRequest(id)).status).toBe('withdrawn');
  });

  it('concurrent approve and withdraw on two connections: approve holding the row first wins', async () => {
    const id = await seedRequest(agent);
    const gate = deferred();
    const locked = deferred();

    // Connection 1: the technician's respond CAS, held open before commit.
    const approving = withDbAccessContext(agentContext(agent), async () => {
      const rows = await approveCas(db, id);
      locked.release();
      await gate.promise;
      return rows;
    });
    await locked.promise;

    // Connection 2: the agent's withdraw must wait on the row lock.
    const withdrawing = withdraw(agent, id);
    expect(await settledWithin(withdrawing, 300)).toBe('pending');

    gate.release();
    expect(await approving).toHaveLength(1);
    expect(await withdrawing).toEqual({ kind: 'not_pending', status: 'approved' });
    expect((await readRequest(id)).status).toBe('approved');
    expect(await readAudit(id)).toHaveLength(0);
  });

  it('concurrent approve and withdraw on two connections: withdraw holding the row first wins', async () => {
    const id = await seedRequest(agent);
    const gate = deferred();
    const locked = deferred();

    // Connection 1: the withdraw's row lock is held until the outer context
    // commits (the route runs inside the request-long agent transaction).
    const withdrawing = withDbAccessContext(agentContext(agent), async () => {
      const result = await withdrawElevationRequest({
        orgId: agent.orgId, deviceId: agent.deviceId, requestId: id, reason: 'user_denied', agentDeclinedAt: null,
      });
      locked.release();
      await gate.promise;
      return result;
    });
    await locked.promise;

    // Connection 2: the respond CAS blocks on the lock, then finds it withdrawn.
    const approving = withDbAccessContext(agentContext(agent), () => approveCas(db, id));
    expect(await settledWithin(approving, 300)).toBe('pending');

    gate.release();
    expect(await withdrawing).toMatchObject({ kind: 'withdrawn', replay: false });
    expect(await approving).toHaveLength(0);
    expect((await readRequest(id)).status).toBe('withdrawn');
  });

  it('concurrent approve and withdraw released together: exactly one wins', async () => {
    for (let i = 0; i < 5; i++) {
      const id = await seedRequest(agent);
      const [approved, withdrawn] = await Promise.all([
        withDbAccessContext(agentContext(agent), () => approveCas(db, id)),
        withdraw(agent, id),
      ]);
      const row = await readRequest(id);
      if (row.status === 'approved') {
        expect(approved).toHaveLength(1);
        expect(withdrawn).toEqual({ kind: 'not_pending', status: 'approved' });
      } else {
        expect(row.status).toBe('withdrawn');
        expect(approved).toHaveLength(0);
        expect(withdrawn).toMatchObject({ kind: 'withdrawn', replay: false });
      }
    }
  });

  it("another device's request in the same org is not found", async () => {
    const other = await seedAgent('b', agent);
    const id = await seedRequest(agent);

    expect(await withdraw(agent, id, { ctxAgent: other, deviceId: other.deviceId })).toEqual({ kind: 'not_found' });
    expect((await readRequest(id)).status).toBe('pending');
  });

  it("another org's request is not found, even naming the right device id", async () => {
    const stranger = await seedAgent('c');
    const id = await seedRequest(agent);

    expect(await withdraw(agent, id, { ctxAgent: stranger, deviceId: agent.deviceId })).toEqual({ kind: 'not_found' });
    expect((await readRequest(id)).status).toBe('pending');
  });

  it('a technician JIT request on the same device is not found', async () => {
    const [tech] = await getTestDb().insert(users)
      .values({ partnerId: agent.partnerId, email: `t-8971-${randomUUID().slice(0, 8)}@example.test`, name: 'Tech', status: 'active' })
      .returning({ id: users.id });
    const id = await seedRequest(agent, { flowType: 'tech_jit_admin', subjectUserId: tech!.id });

    expect(await withdraw(agent, id)).toEqual({ kind: 'not_found' });
    expect((await readRequest(id)).status).toBe('pending');
  });

  it('an expired row is not_pending expired', async () => {
    const id = await seedRequest(agent);
    await getTestDb().update(elevationRequests).set({ status: 'expired', expiredAt: new Date() }).where(eq(elevationRequests.id, id));

    expect(await withdraw(agent, id)).toEqual({ kind: 'not_pending', status: 'expired' });
  });

  it('device moved (ownership-change expiry) then withdraw is not_pending expired', async () => {
    const id = await seedRequest(agent);
    expect(await expireUnactuatedElevationRequests(getTestDb(), { orgId: agent.orgId, deviceId: agent.deviceId })).toBe(1);

    expect(await withdraw(agent, id)).toEqual({ kind: 'not_pending', status: 'expired' });
    expect((await readRequest(id)).withdrawnAt).toBeNull();
  });
});

describe('POST /agents/:id/elevation-requests/:requestId/withdraw through agent auth (#8971)', () => {
  let agent: Agent;

  function buildAgentApp(): Hono {
    const app = new Hono();
    app.route('/api/v1/agents', agentRoutes);
    return app;
  }

  function post(a: Agent, requestId: string, opts: { pathAgentId?: string; token?: string } = {}) {
    return buildAgentApp().request(`/api/v1/agents/${opts.pathAgentId ?? a.agentId}/elevation-requests/${requestId}/withdraw`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.token ?? a.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'user_denied', declinedAt: '2027-01-10T10:00:00.000Z' }),
    });
  }

  beforeEach(async () => {
    agent = await seedAgent('route');
  });

  it('withdraws the owning device\'s pending request, audits it, and expires its phone approvals', async () => {
    const id = await seedRequest(agent);
    await seedPhoneApprovals(agent, id);

    const res = await post(agent, id);

    expect(res.status).toBe(200);
    const body = await res.json() as { id: string; status: string; withdrawnAt: string };
    expect(body).toMatchObject({ id, status: 'withdrawn' });
    const row = await readRequest(id);
    expect(row.status).toBe('withdrawn');
    expect(new Date(body.withdrawnAt).getTime()).toBe(row.withdrawnAt!.getTime());
    expect((await readAudit(id)).map((r) => r.eventType)).toEqual(['withdrawn']);

    // Runs after the request transaction exits (runAfterDbContextExit).
    await vi.waitFor(async () => {
      const phones = await getTestDb().select({ status: approvalRequests.status })
        .from(approvalRequests).where(eq(approvalRequests.elevationRequestId, id));
      expect(phones.map((p) => p.status)).toEqual(['expired', 'expired']);
    }, { timeout: 5_000, interval: 100 });
  });

  it('a replay returns 200 with the stored withdrawnAt', async () => {
    const id = await seedRequest(agent);
    const first = await (await post(agent, id)).json() as { withdrawnAt: string };

    const res = await post(agent, id);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id, status: 'withdrawn', withdrawnAt: first.withdrawnAt });
    expect(await readAudit(id)).toHaveLength(1);
  });

  it('an approved request answers 409 not_pending with its status', async () => {
    const id = await seedRequest(agent, { status: 'approved' });

    const res = await post(agent, id);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'not_pending', status: 'approved' });
    expect((await readRequest(id)).status).toBe('approved');
  });

  it('rejects a bad agent token before touching the request', async () => {
    const id = await seedRequest(agent);

    const res = await post(agent, id, { token: `${agent.token}-wrong` });

    expect(res.status).toBe(401);
    expect((await readRequest(id)).status).toBe('pending');
  });

  it('rejects a path that names a different agent', async () => {
    const other = await seedAgent('route-b', agent);
    const id = await seedRequest(agent);

    const res = await post(agent, id, { pathAgentId: other.agentId });

    expect([401, 403]).toContain(res.status);
    expect((await readRequest(id)).status).toBe('pending');
  });

  it('another device in the same org gets 404; the owner can still withdraw', async () => {
    const other = await seedAgent('route-c', agent);
    const id = await seedRequest(agent);

    expect((await post(other, id)).status).toBe(404);
    expect((await readRequest(id)).status).toBe('pending');
    expect((await post(agent, id)).status).toBe(200);
  });

  it('a device in another org gets 404; the owner can still withdraw', async () => {
    const stranger = await seedAgent('route-d');
    const id = await seedRequest(agent);

    expect((await post(stranger, id)).status).toBe(404);
    expect((await readRequest(id)).status).toBe('pending');
    expect((await post(agent, id)).status).toBe(200);
  });
});
