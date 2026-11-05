/**
 * A device's command history reads as the history of its CURRENT organization,
 * end to end: real `POST /devices/:id/move-org`, real org-scoped sessions, real
 * row-level policies on `device_ownership_epochs` and `org_merge_events`.
 *
 * `device_commands` has no `org_id` and the move does not rewrite its rows, so
 * what scopes a read is `submitted_org_id` plus the device's ownership epochs.
 * Only a real database can prove the part of that which depends on what an
 * org-scoped session can actually see.
 *
 * Run:
 *   pnpm test-stack up
 *   npx vitest run --config vitest.integration.config.ts src/__tests__/integration/deviceCommandHistoryOrgScope.integration.test.ts
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { withSystemDbAccessContext, db } from '../../db';
import { deviceCommands, devices, orgMergeEvents } from '../../db/schema';
import { authMiddleware } from '../../middleware/auth';
import { deviceRoutes } from '../../routes/devices';
import { moveOrgRoutes } from '../../routes/devices/moveOrg';
import { createAccessToken } from '../../services/jwt';
import {
  assignUserToOrganization,
  createOrganization,
  createRole,
  createSite,
  createUser,
  grantRolePermissions,
  setupTestEnvironment,
} from './db-utils';
import { getTestDb } from './setup';
import { withMoveOrgStepUpGrant } from './moveOrgStepUpFixture';

const READ_AND_EXECUTE = [
  { resource: 'devices', action: 'read' },
  { resource: 'devices', action: 'execute' },
];

function buildApp(): Hono {
  const app = new Hono();
  app.use('*', authMiddleware);
  app.route('/devices', deviceRoutes);
  return app;
}

async function orgUserToken(partnerId: string, orgId: string): Promise<string> {
  const user = await createUser({ partnerId, orgId, email: `org-${randomUUID()}@example.com` });
  const role = await createRole({ scope: 'organization', orgId, partnerId });
  await grantRolePermissions(role.id, READ_AND_EXECUTE);
  await assignUserToOrganization(user.id, orgId, role.id);
  return createAccessToken({
    sub: user.id,
    email: user.email,
    roleId: role.id,
    orgId,
    partnerId,
    scope: 'organization',
    mfa: true,
    aep: 1,
    mep: 1,
    sid: `it-${randomUUID()}`,
  });
}

async function seed() {
  const env = await setupTestEnvironment({ scope: 'partner' });
  const sourceOrg = env.organization;
  const targetOrg = await createOrganization({ partnerId: env.partner.id });
  const targetSite = await createSite({ orgId: targetOrg.id });
  const [device] = await getTestDb()
    .insert(devices)
    .values({
      orgId: sourceOrg.id,
      siteId: env.site.id,
      agentId: `history-scope-${randomUUID()}`,
      hostname: `history-scope-${randomUUID().slice(0, 8)}`,
      osType: 'windows',
      osVersion: '11',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'online',
      enrolledAt: new Date(),
    })
    .returning({ id: devices.id });
  const partnerToken = await createAccessToken({
    sub: env.user.id,
    email: env.user.email,
    roleId: env.role.id,
    orgId: null,
    partnerId: env.partner.id,
    scope: 'partner',
    mfa: true,
    aep: 1,
    mep: 1,
    sid: `it-${randomUUID()}`,
  });
  return { ...env, sourceOrg, targetOrg, targetSite, deviceId: device!.id, partnerToken };
}

type Fixture = Awaited<ReturnType<typeof seed>>;

async function insertCommand(
  deviceId: string,
  over: Partial<typeof deviceCommands.$inferInsert> = {},
): Promise<string> {
  const [row] = await getTestDb()
    .insert(deviceCommands)
    .values({
      deviceId,
      type: 'patch_scan',
      status: 'completed',
      completedAt: new Date(),
      result: { status: 'completed' },
      ...over,
    })
    .returning({ id: deviceCommands.id });
  return row!.id;
}

async function moveThroughRoute(f: Fixture, targetOrgId: string, targetSiteId: string): Promise<void> {
  const app = new Hono();
  app.route('/devices', moveOrgRoutes);
  const res = await app.request(`/devices/${f.deviceId}/move-org`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${f.partnerToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(
      await withMoveOrgStepUpGrant(f.partnerToken, f.deviceId, { orgId: targetOrgId, siteId: targetSiteId }),
    ),
  });
  expect(res.status, await res.clone().text()).toBe(200);
}

/** Repoints the device the way the merge engine does: `org_merge` armed, then the org flip. */
async function repointAsOrgMerge(deviceId: string, orgId: string, siteId: string): Promise<void> {
  await withSystemDbAccessContext(() =>
    db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('breeze.ownership_change_cause', 'org_merge', true)`);
      await tx.update(devices).set({ orgId, siteId }).where(eq(devices.id, deviceId));
    }),
  );
}

async function recordMerge(partnerId: string, loserOrgId: string, survivorOrgId: string): Promise<void> {
  await getTestDb()
    .insert(orgMergeEvents)
    .values({ partnerId, loserOrgId, loserOrgName: 'merged away', survivorOrgId, summary: {} });
}

async function historyIds(app: Hono, token: string, deviceId: string): Promise<{ ids: string[]; total: number }> {
  const res = await app.request(`/devices/${deviceId}/patches/history?limit=100`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status, await res.clone().text()).toBe(200);
  const body = (await res.json()) as { history: Array<{ id: string }>; total: number };
  return { ids: body.history.map((row) => row.id).sort(), total: body.total };
}

describe('device command history is scoped to the current organization', () => {
  it('after a move, the new organization sees only rows from after the move', async () => {
    const f = await seed();
    const app = buildApp();
    const preMoveStamped = await insertCommand(f.deviceId, { submittedOrgId: f.sourceOrg.id });
    // No provenance on the row: this is what rows written before the column
    // existed, and rows whose source org was later erased, look like.
    const preMoveUnstamped = await insertCommand(f.deviceId);

    const sourceToken = await orgUserToken(f.partner.id, f.sourceOrg.id);
    expect((await historyIds(app, sourceToken, f.deviceId)).ids).toEqual([preMoveStamped, preMoveUnstamped].sort());

    await moveThroughRoute(f, f.targetOrg.id, f.targetSite.id);

    const postMoveStamped = await insertCommand(f.deviceId, { submittedOrgId: f.targetOrg.id });
    const postMoveUnstamped = await insertCommand(f.deviceId);

    const targetToken = await orgUserToken(f.partner.id, f.targetOrg.id);
    const expected = [postMoveStamped, postMoveUnstamped].sort();
    const seen = await historyIds(app, targetToken, f.deviceId);
    expect(seen.ids).toEqual(expected);
    expect(seen.total, 'the count must agree with the page').toBe(expected.length);
    // A partner-scoped session sees the same device history, not a wider one.
    expect((await historyIds(app, f.partnerToken, f.deviceId)).ids).toEqual(expected);

    // The source organization no longer reaches the device at all.
    const sourceAfter = await app.request(`/devices/${f.deviceId}/patches/history`, {
      headers: { Authorization: `Bearer ${sourceToken}` },
    });
    expect(sourceAfter.status).toBe(404);
  });

  it('a device that never moved keeps its whole history, stamped or not', async () => {
    const f = await seed();
    const app = buildApp();
    const stamped = await insertCommand(f.deviceId, { submittedOrgId: f.sourceOrg.id });
    const unstamped = await insertCommand(f.deviceId);
    const token = await orgUserToken(f.partner.id, f.sourceOrg.id);
    expect((await historyIds(app, token, f.deviceId)).ids).toEqual([stamped, unstamped].sort());
  });

  it('a device back in an organization it left sees that organization’s stamped rows, not the interim ones', async () => {
    const f = await seed();
    const app = buildApp();
    const firstTenure = await insertCommand(f.deviceId, { submittedOrgId: f.sourceOrg.id });
    await moveThroughRoute(f, f.targetOrg.id, f.targetSite.id);
    await insertCommand(f.deviceId, { submittedOrgId: f.targetOrg.id });
    await insertCommand(f.deviceId);
    await moveThroughRoute(f, f.sourceOrg.id, f.site.id);
    const secondTenure = await insertCommand(f.deviceId, { submittedOrgId: f.sourceOrg.id });

    const token = await orgUserToken(f.partner.id, f.sourceOrg.id);
    expect((await historyIds(app, token, f.deviceId)).ids).toEqual([firstTenure, secondTenure].sort());
  });

  it('an org merge carries the merged-away organization’s rows to the survivor, transitively', async () => {
    const f = await seed();
    const app = buildApp();
    // source (loser) -> target (survivor of the first merge, loser of the next) -> final
    const finalOrg = await createOrganization({ partnerId: f.partner.id });
    const finalSite = await createSite({ orgId: finalOrg.id });

    const stampedLoser = await insertCommand(f.deviceId, { submittedOrgId: f.sourceOrg.id });
    const unstampedLoser = await insertCommand(f.deviceId);

    await recordMerge(f.partner.id, f.sourceOrg.id, f.targetOrg.id);
    await repointAsOrgMerge(f.deviceId, f.targetOrg.id, f.targetSite.id);
    await recordMerge(f.partner.id, f.targetOrg.id, finalOrg.id);
    await repointAsOrgMerge(f.deviceId, finalOrg.id, finalSite.id);

    // An organization outside the merge lineage stays out on this path too.
    const unrelatedOrg = await createOrganization({ partnerId: f.partner.id });
    await insertCommand(f.deviceId, { submittedOrgId: unrelatedOrg.id });

    const expected = [stampedLoser, unstampedLoser].sort();
    const token = await orgUserToken(f.partner.id, finalOrg.id);
    expect((await historyIds(app, token, f.deviceId)).ids).toEqual(expected);
    expect((await historyIds(app, f.partnerToken, f.deviceId)).ids).toEqual(expected);
  });

  it('a merged device that left and came back keeps the lineage but only this tenure’s unstamped rows', async () => {
    const f = await seed();
    const app = buildApp();
    const survivor = await createOrganization({ partnerId: f.partner.id });
    const survivorSite = await createSite({ orgId: survivor.id });

    const stampedLoser = await insertCommand(f.deviceId, { submittedOrgId: f.sourceOrg.id });
    await insertCommand(f.deviceId);
    await recordMerge(f.partner.id, f.sourceOrg.id, survivor.id);
    await repointAsOrgMerge(f.deviceId, survivor.id, survivorSite.id);

    await moveThroughRoute(f, f.targetOrg.id, f.targetSite.id);
    await insertCommand(f.deviceId, { submittedOrgId: f.targetOrg.id });
    await insertCommand(f.deviceId);
    await moveThroughRoute(f, survivor.id, survivorSite.id);
    const afterReturn = await insertCommand(f.deviceId);

    const token = await orgUserToken(f.partner.id, survivor.id);
    expect((await historyIds(app, token, f.deviceId)).ids).toEqual([stampedLoser, afterReturn].sort());
  });

  it('the scope holds when the routes’ own filters are applied', async () => {
    const f = await seed();
    const app = buildApp();
    await insertCommand(f.deviceId, { submittedOrgId: f.sourceOrg.id });
    await insertCommand(f.deviceId, { status: 'failed', submittedOrgId: f.sourceOrg.id });
    await moveThroughRoute(f, f.targetOrg.id, f.targetSite.id);
    const completed = await insertCommand(f.deviceId, { submittedOrgId: f.targetOrg.id });
    const failed = await insertCommand(f.deviceId, { status: 'failed', submittedOrgId: f.targetOrg.id });

    const token = await orgUserToken(f.partner.id, f.targetOrg.id);
    const headers = { Authorization: `Bearer ${token}` };

    const history = await app.request(
      `/devices/${f.deviceId}/patches/history?type=scan&status=failed`,
      { headers },
    );
    expect(history.status).toBe(200);
    const historyBody = (await history.json()) as { history: Array<{ id: string }>; total: number };
    expect(historyBody.history.map((row) => row.id)).toEqual([failed]);
    expect(historyBody.total).toBe(1);

    const list = await app.request(`/devices/${f.deviceId}/commands?status=completed`, { headers });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { data: Array<{ id: string }>; pagination: { total: number } };
    expect(listBody.data.map((row) => row.id)).toEqual([completed]);
    expect(listBody.pagination.total).toBe(1);
  });

  it('a merge does not reach back past an earlier move into the merged-away organization', async () => {
    const f = await seed();
    const app = buildApp();
    const finalOrg = await createOrganization({ partnerId: f.partner.id });
    const finalSite = await createSite({ orgId: finalOrg.id });

    await insertCommand(f.deviceId, { submittedOrgId: f.sourceOrg.id });
    await insertCommand(f.deviceId);

    await moveThroughRoute(f, f.targetOrg.id, f.targetSite.id);
    const afterMove = await insertCommand(f.deviceId);
    const stampedAfterMove = await insertCommand(f.deviceId, { submittedOrgId: f.targetOrg.id });

    await recordMerge(f.partner.id, f.targetOrg.id, finalOrg.id);
    await repointAsOrgMerge(f.deviceId, finalOrg.id, finalSite.id);

    const token = await orgUserToken(f.partner.id, finalOrg.id);
    expect((await historyIds(app, token, f.deviceId)).ids).toEqual([afterMove, stampedAfterMove].sort());
  });

  it('the device command list, single read and cancel follow the same rule', async () => {
    const f = await seed();
    const app = buildApp();
    const preMove = await insertCommand(f.deviceId, { submittedOrgId: f.sourceOrg.id });
    // Survives a move on purpose: a queued removal still has to reach the agent.
    const queuedRemoval = await insertCommand(f.deviceId, {
      type: 'self_uninstall',
      status: 'pending',
      completedAt: null,
      result: null,
      submittedOrgId: f.sourceOrg.id,
    });
    await moveThroughRoute(f, f.targetOrg.id, f.targetSite.id);
    const postMove = await insertCommand(f.deviceId, { submittedOrgId: f.targetOrg.id });

    const token = await orgUserToken(f.partner.id, f.targetOrg.id);
    const headers = { Authorization: `Bearer ${token}` };

    const list = await app.request(`/devices/${f.deviceId}/commands`, { headers });
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { data: Array<{ id: string }>; pagination: { total: number } };
    expect(listed.data.map((row) => row.id)).toEqual([postMove]);
    expect(listed.pagination.total).toBe(1);

    expect((await app.request(`/devices/${f.deviceId}/commands/${postMove}`, { headers })).status).toBe(200);
    expect((await app.request(`/devices/${f.deviceId}/commands/${preMove}`, { headers })).status).toBe(404);

    const cancel = await app.request(`/devices/${f.deviceId}/commands/${queuedRemoval}/cancel`, {
      method: 'POST',
      headers,
    });
    expect(cancel.status).toBe(404);
    const [row] = await getTestDb()
      .select({ status: deviceCommands.status })
      .from(deviceCommands)
      .where(eq(deviceCommands.id, queuedRemoval));
    expect(row?.status).toBe('pending');
  });

  it('the last-scan summary, mark-failed and the cleanup catalogue poll follow the same rule', async () => {
    const f = await seed();
    const app = buildApp();
    await insertCommand(f.deviceId, { submittedOrgId: f.sourceOrg.id });
    const sentBeforeMove = await insertCommand(f.deviceId, {
      type: 'script',
      status: 'sent',
      completedAt: null,
      result: null,
      executedAt: new Date(Date.now() - 60 * 60 * 1000),
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
      submittedOrgId: f.sourceOrg.id,
    });
    const cleanupBeforeMove = await insertCommand(f.deviceId, {
      type: 'system_cleanup_list',
      submittedOrgId: f.sourceOrg.id,
    });
    await moveThroughRoute(f, f.targetOrg.id, f.targetSite.id);

    const token = await orgUserToken(f.partner.id, f.targetOrg.id);
    const headers = { Authorization: `Bearer ${token}` };

    const status = await app.request(`/devices/${f.deviceId}/patches`, { headers });
    expect(status.status, await status.clone().text()).toBe(200);
    const statusBody = (await status.json()) as { data: { lastPatchScanAt: string | null } };
    expect(statusBody.data.lastPatchScanAt).toBeNull();

    const markFailed = await app.request(`/devices/${f.deviceId}/commands/${sentBeforeMove}/mark-failed`, {
      method: 'POST',
      headers,
    });
    expect(markFailed.status).toBe(404);
    const [row] = await getTestDb()
      .select({ status: deviceCommands.status })
      .from(deviceCommands)
      .where(eq(deviceCommands.id, sentBeforeMove));
    expect(row?.status).toBe('sent');

    const poll = await app.request(
      `/devices/${f.deviceId}/filesystem/system-cleanup/list/${cleanupBeforeMove}`,
      { headers },
    );
    expect(poll.status).toBe(404);
  });

  it('an erased source organization does not turn its rows into the new organization’s', async () => {
    const f = await seed();
    const app = buildApp();
    await insertCommand(f.deviceId, { submittedOrgId: f.sourceOrg.id });
    await moveThroughRoute(f, f.targetOrg.id, f.targetSite.id);
    const postMove = await insertCommand(f.deviceId, { submittedOrgId: f.targetOrg.id });

    // The FK's ON DELETE SET NULL, as erasing the source org leaves the row.
    await getTestDb()
      .update(deviceCommands)
      .set({ submittedOrgId: null })
      .where(eq(deviceCommands.submittedOrgId, f.sourceOrg.id));

    const token = await orgUserToken(f.partner.id, f.targetOrg.id);
    expect((await historyIds(app, token, f.deviceId)).ids).toEqual([postMove]);
  });
});
