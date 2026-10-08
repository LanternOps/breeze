/**
 * Parked-device assignment against real Postgres + Redis.
 *
 * Proven here:
 *   - an in-flight parked heartbeat blocks on the assignment's device row
 *     lock; after commit the device is in the target org, its liveness
 *     advanced, and no device child row was written under the holding org;
 *   - a failure after the ledger insert rolls everything back — no
 *     `assigned` ledger row, the device still parked;
 *   - the shared move engine itself refuses a generic move out of a holding
 *     org and any move into one, independent of any route;
 *   plus the real step-up grant (consumed inside the transaction, single use),
 *   the capacity admission, the destination checks, and latency ceilings for a
 *   single and a 25-device bulk assignment.
 *
 * Run (needs `pnpm test-stack up`):
 *   cd apps/api && npx vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/parkedAssignment.integration.test.ts
 */
import './setup';

import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createHash, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { getTestDb } from './setup';
import { createOrganization, createPartner, createSite, createUser, setupTestEnvironment } from './db-utils';
import { seedHoldingOrg } from './unassignedPoolFixtures';
import { declareParkedDeviceAdmission } from '../../services/unassignedPool/admission';
import { devicePoolAssignmentEvents, devices, partners, refreshTokenFamilies } from '../../db/schema';
import { preAssignmentRoutes } from '../../routes/preAssignment';
import { createAccessToken, type TokenPayload } from '../../services/jwt';
import { agentRoutes } from '../../routes/agents/index';
import { db, withSystemDbAccessContext } from '../../db';
import {
  assignParkedDevice,
  assignParkedDevicesBulk,
  type ParkedAssignmentActor,
} from '../../services/unassignedPool/assignParkedDevice';
import {
  DevicePoolMembershipRefusedError,
  moveDeviceOrgInTransaction,
} from '../../services/deviceOrgMove/moveDeviceOrgInTransaction';
import {
  mintStepUpGrant,
  parkedAssignResourceDigest,
  parkedBulkAssignResourceDigest,
  type StepUpGrantBinding,
} from '../../services/mfaStepUpGrant';

const MOUNT = '/api/v1/agents';
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const request = { req: { header: () => undefined } };

let partnerId: string;
let pool: { orgId: string; siteId: string };
let targetOrgId: string;
let targetSiteId: string;
let actor: ParkedAssignmentActor;

async function seedParked(opts: { lastSeenAt?: Date; hostname?: string } = {}) {
  const suffix = randomUUID().slice(0, 8);
  const agentToken = `brz_assign_${suffix}`;
  const agentId = `parked-assign-${suffix}`;
  const row = await getTestDb().transaction(async (tx: any) => {
    await declareParkedDeviceAdmission(tx);
    const [inserted] = await tx.insert(devices).values({
      orgId: pool.orgId,
      siteId: pool.siteId,
      agentId,
      hostname: opts.hostname ?? `parked-${suffix}`,
      agentTokenHash: digest(agentToken),
      tokenIssuedAt: new Date(),
      mtlsCertIssuedAt: new Date(),
      mtlsCertExpiresAt: new Date(Date.now() + 30 * 86_400_000),
      status: 'online',
      lastSeenAt: opts.lastSeenAt ?? new Date(Date.now() - 3_600_000),
      osType: 'linux',
      osVersion: 'test',
      architecture: 'x64',
      agentVersion: '0.70.0',
    }).returning({ id: devices.id });
    return inserted!;
  });
  return { id: row.id as string, agentId, agentToken };
}

async function deviceRow(id: string) {
  const [row] = await getTestDb().select().from(devices).where(eq(devices.id, id)).limit(1);
  return row!;
}

async function assignedLedgerRows(deviceId: string) {
  return getTestDb().select().from(devicePoolAssignmentEvents).where(and(
    eq(devicePoolAssignmentEvents.deviceId, deviceId),
    eq(devicePoolAssignmentEvents.eventType, 'assigned'),
  ));
}

/**
 * Rows keyed to (device, org) across every table carrying both device_id and
 * org_id — the child rows a heartbeat could write under the old org.
 */
// Ownership lineage (#8203) is excluded: the assignment's org change itself
// closes the departing epoch under the holding org via the
// breeze_device_ownership_epoch_advance() trigger. That row is written by the
// move, not by a raced heartbeat, and is pinned by
// deviceOwnershipEpochs.integration.test.ts.
const LINEAGE_TABLES = ['device_ownership_epochs', 'device_ownership_epoch_closures'];

async function childRowsUnderOrg(deviceId: string, orgId: string): Promise<number> {
  const tables = await getTestDb().execute<{ table_name: string }>(sql`
    SELECT c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
     WHERE c.table_schema = 'public' AND c.column_name = 'device_id'
       AND c.table_name NOT IN (${sql.join(LINEAGE_TABLES.map((t) => sql`${t}`), sql`, `)})
       AND EXISTS (SELECT 1 FROM information_schema.columns o
                    WHERE o.table_schema = 'public' AND o.table_name = c.table_name AND o.column_name = 'org_id')
     ORDER BY c.table_name`);
  let total = 0;
  for (const { table_name } of tables as unknown as Array<{ table_name: string }>) {
    const [row] = await getTestDb().execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM ${sql.identifier(table_name)} WHERE device_id = ${deviceId}::uuid AND org_id = ${orgId}::uuid`,
    ) as unknown as Array<{ n: number }>;
    total += Number(row?.n ?? 0);
  }
  return total;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A live sign-in session (refresh-token family) for `userId`; returns its id. */
async function seedSession(userId: string): Promise<string> {
  const familyId = randomUUID();
  await getTestDb().insert(refreshTokenFamilies).values({
    familyId,
    userId,
    absoluteExpiresAt: new Date(Date.now() + 86_400_000),
  });
  return familyId;
}

/**
 * Waits until some backend is blocked on a lock while running an UPDATE of
 * the devices table — i.e. the heartbeat's liveness write is queued behind
 * the assignment's row lock. Deterministic: polls the server's own view.
 */
async function waitForBlockedDevicesUpdate(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = await getTestDb().execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE datname = current_database()
         AND wait_event_type = 'Lock'
         AND query ILIKE 'update "devices"%'`) as unknown as Array<{ n: number }>;
    if (Number(row?.n ?? 0) > 0) return;
    await sleep(25);
  }
  throw new Error('no UPDATE of devices became blocked on a lock');
}

beforeEach(async () => {
  const partner = await createPartner({ status: 'active' });
  partnerId = partner.id;
  pool = await seedHoldingOrg(partnerId);
  const org = await createOrganization({ partnerId, status: 'active' });
  const site = await createSite({ orgId: org.id });
  targetOrgId = org.id;
  targetSiteId = site.id;
  const user = await createUser({ partnerId, email: `assign-${randomUUID()}@example.com` });
  const sid = await seedSession(user.id);
  actor = {
    partnerId,
    allowedSiteIds: undefined,
    auth: {
      scope: 'partner',
      partnerId,
      partnerOrgAccess: 'all',
      user: { id: user.id, email: user.email, name: 'Admin' },
      token: { aep: user.authEpoch, mep: user.mfaEpoch, sid },
    } as any,
  };
});

describe('parked assignment — happy path with a real step-up grant', () => {
  it('assigns, consumes the grant inside the transaction, writes the ledger row, and refuses a replay', async () => {
    const parked = await seedParked();
    const binding: StepUpGrantBinding = {
      userId: actor.auth.user.id,
      operation: 'parked_device_assign',
      authEpoch: actor.auth.token!.aep!,
      mfaEpoch: actor.auth.token!.mep!,
      sid: actor.auth.token!.sid!,
      resourceDigest: parkedAssignResourceDigest({ deviceId: parked.id, targetOrgId, targetSiteId }),
    };
    const grantId = await mintStepUpGrant(binding);
    expect(grantId).toBeTruthy();

    const started = performance.now();
    const result = await assignParkedDevice({
      actor,
      item: { deviceId: parked.id, targetOrgId, targetSiteId },
      stepUp: { grantId: grantId!, binding },
      audit: request,
    });
    const elapsedMs = performance.now() - started;
    process.stdout.write(`[parkedAssignment] single assignment latency: ${elapsedMs.toFixed(1)} ms\n`);
    expect(elapsedMs).toBeLessThan(2_000);

    expect(result).toMatchObject({ ok: true, deviceId: parked.id, targetOrgId, targetSiteId });
    const after = await deviceRow(parked.id);
    expect(after.orgId).toBe(targetOrgId);
    expect(after.siteId).toBe(targetSiteId);

    const ledger = await assignedLedgerRows(parked.id);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      partnerId,
      deviceAgentId: parked.agentId,
      fromOrgId: pool.orgId,
      toOrgId: targetOrgId,
      assignmentMethod: 'manual',
      assignedByUserId: actor.auth.user.id,
      stepUpGrantRef: grantId,
    });
    expect(ledger[0]!.parkedDurationSeconds).toBeGreaterThanOrEqual(0);

    // The same grant cannot authorize a second assignment.
    const second = await seedParked();
    const replay = await assignParkedDevice({
      actor,
      item: { deviceId: second.id, targetOrgId, targetSiteId },
      stepUp: { grantId: grantId!, binding },
      audit: request,
    });
    expect(replay).toMatchObject({ ok: false, code: 'STEP_UP_REQUIRED' });
    expect((await deviceRow(second.id)).orgId).toBe(pool.orgId);
  });

  it('a second assignment of the same device is refused: it is no longer parked', async () => {
    const parked = await seedParked();
    expect(await assignParkedDevice({ actor, item: { deviceId: parked.id, targetOrgId, targetSiteId }, stepUp: null, audit: request }))
      .toMatchObject({ ok: true });
    const other = await createOrganization({ partnerId, status: 'active' });
    const otherSite = await createSite({ orgId: other.id });
    expect(await assignParkedDevice({ actor, item: { deviceId: parked.id, targetOrgId: other.id, targetSiteId: otherSite.id }, stepUp: null, audit: request }))
      .toMatchObject({ ok: false, code: 'DEVICE_NOT_PARKED' });
    expect((await deviceRow(parked.id)).orgId).toBe(targetOrgId);
    expect(await assignedLedgerRows(parked.id)).toHaveLength(1);
  });

  it("refuses another partner's destination and another partner's parked device", async () => {
    const parked = await seedParked();
    const otherPartner = await createPartner({ status: 'active' });
    const foreignOrg = await createOrganization({ partnerId: otherPartner.id, status: 'active' });
    const foreignSite = await createSite({ orgId: foreignOrg.id });
    expect(await assignParkedDevice({ actor, item: { deviceId: parked.id, targetOrgId: foreignOrg.id, targetSiteId: foreignSite.id }, stepUp: null, audit: request }))
      .toMatchObject({ ok: false, code: 'TARGET_ORG_INVALID' });

    const foreignActor: ParkedAssignmentActor = { ...actor, partnerId: otherPartner.id, auth: { ...actor.auth, partnerId: otherPartner.id } as any };
    expect(await assignParkedDevice({ actor: foreignActor, item: { deviceId: parked.id, targetOrgId: foreignOrg.id, targetSiteId: foreignSite.id }, stepUp: null, audit: request }))
      .toMatchObject({ ok: false, code: 'DEVICE_NOT_FOUND' });
    expect((await deviceRow(parked.id)).orgId).toBe(pool.orgId);
    expect(await assignedLedgerRows(parked.id)).toHaveLength(0);
  });

  it('refuses a hostname already at the destination site unless accepted', async () => {
    const parked = await seedParked({ hostname: 'DUP-HOST' });
    await getTestDb().insert(devices).values({
      orgId: targetOrgId, siteId: targetSiteId, agentId: `existing-${randomUUID()}`.slice(0, 64), hostname: 'DUP-HOST',
      osType: 'linux', osVersion: 'test', architecture: 'x64', agentVersion: 'test', status: 'online',
    });
    expect(await assignParkedDevice({ actor, item: { deviceId: parked.id, targetOrgId, targetSiteId }, stepUp: null, audit: request }))
      .toMatchObject({ ok: false, code: 'DEVICE_IDENTITY_COLLISION' });
    expect(await assignParkedDevice({ actor, item: { deviceId: parked.id, targetOrgId, targetSiteId, acceptIdentityCollision: true }, stepUp: null, audit: request }))
      .toMatchObject({ ok: true });
  });

  it('admits licensed capacity at assignment; parked devices never count toward it', async () => {
    // Parked devices are outside the licensed count: with max_devices = 1 and
    // only parked devices, the first assignment is admitted.
    const parked = await seedParked();
    const parkedToo = await seedParked();
    await getTestDb().update(partners).set({ maxDevices: 1 }).where(eq(partners.id, partnerId));
    expect(await assignParkedDevice({ actor, item: { deviceId: parked.id, targetOrgId, targetSiteId }, stepUp: null, audit: request }))
      .toMatchObject({ ok: true });
    // The assigned device now counts: the next one is refused at the cap...
    expect(await assignParkedDevice({ actor, item: { deviceId: parkedToo.id, targetOrgId, targetSiteId }, stepUp: null, audit: request }))
      .toMatchObject({ ok: false, code: 'PARTNER_DEVICE_LIMIT_REACHED' });
    expect((await deviceRow(parkedToo.id)).orgId).toBe(pool.orgId);
    // ...and admitted once there is room.
    await getTestDb().update(partners).set({ maxDevices: 2 }).where(eq(partners.id, partnerId));
    expect(await assignParkedDevice({ actor, item: { deviceId: parkedToo.id, targetOrgId, targetSiteId }, stepUp: null, audit: request }))
      .toMatchObject({ ok: true });
  });
});

describe('concurrent parked heartbeat', () => {
  const beat = (app: Hono, agentId: string, token: string) => app.request(`${MOUNT}/${agentId}/heartbeat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentVersion: '0.70.1',
      status: 'ok',
      metrics: { cpuPercent: 10, ramPercent: 10, ramUsedMb: 100, diskPercent: 10, diskUsedGb: 10 },
    }),
  });

  it('blocks on the device row lock; after commit the device is in the target org, the raced beat wrote nothing under the holding org, and liveness resumes under the new org', async () => {
    const lastSeenBefore = new Date(Date.now() - 3_600_000);
    const parked = await seedParked({ lastSeenAt: lastSeenBefore });
    const childRowsBefore = await childRowsUnderOrg(parked.id, pool.orgId);

    const locked = deferred();
    const release = deferred();
    const assignment = assignParkedDevice(
      { actor, item: { deviceId: parked.id, targetOrgId, targetSiteId }, stepUp: null, audit: request },
      { hooks: { afterDeviceLock: async () => { locked.resolve(); await release.promise; } } },
    );
    await locked.promise;

    const app = new Hono();
    app.route(MOUNT, agentRoutes);
    let heartbeatSettled = false;
    const raced = Promise.resolve(beat(app, parked.agentId, parked.agentToken)).then((res) => { heartbeatSettled = true; return res; });

    await waitForBlockedDevicesUpdate();
    expect(heartbeatSettled, 'the parked beat must wait for the assignment to release the device row').toBe(false);

    release.resolve();
    expect(await assignment).toMatchObject({ ok: true });
    const racedRes = await raced;
    expect(racedRes.status, await racedRes.clone().text()).toBe(200);

    const afterRace = await deviceRow(parked.id);
    expect(afterRace.orgId).toBe(targetOrgId);
    // The raced beat authenticated as parked and wrote through a holding-org
    // context. Once the row belongs to the target org that context can no
    // longer reach it: its liveness write matched nothing, and it wrote no
    // device child row under the holding org.
    expect(afterRace.lastSeenAt!.getTime()).toBe(lastSeenBefore.getTime());
    expect(await childRowsUnderOrg(parked.id, pool.orgId)).toBe(childRowsBefore);
    expect(await assignedLedgerRows(parked.id)).toHaveLength(1);

    // The next beat authenticates as an ordinary device of the target org and
    // records liveness there.
    const next = await beat(app, parked.agentId, parked.agentToken);
    expect(next.status, await next.clone().text()).toBe(200);
    const afterNext = await deviceRow(parked.id);
    expect(afterNext.orgId).toBe(targetOrgId);
    expect(afterNext.lastSeenAt!.getTime()).toBeGreaterThan(lastSeenBefore.getTime());
    expect(await childRowsUnderOrg(parked.id, pool.orgId)).toBe(childRowsBefore);
  }, 30_000);
});

describe('rollback after the ledger insert', () => {
  it('leaves no assigned ledger row and the device still parked', async () => {
    const parked = await seedParked();
    await expect(assignParkedDevice(
      { actor, item: { deviceId: parked.id, targetOrgId, targetSiteId }, stepUp: null, audit: request },
      { hooks: { afterLedgerInsert: async () => { throw new Error('forced failure after the ledger insert'); } } },
    )).rejects.toThrow('forced failure after the ledger insert');

    expect(await assignedLedgerRows(parked.id)).toHaveLength(0);
    const after = await deviceRow(parked.id);
    expect(after.orgId).toBe(pool.orgId);
    expect(after.siteId).toBe(pool.siteId);
  });
});

describe('the move engine refuses holding-area transitions on its own', () => {
  const runEngine = (input: { deviceId: string; sourceOrgId: string; targetOrgId: string; targetSiteId: string; via: 'generic_move' | 'pool_assignment' }) =>
    withSystemDbAccessContext(() => db.transaction((tx) => moveDeviceOrgInTransaction(tx, {
      ...input,
      targetOrgName: 'target',
      deviceLinkGroupId: null,
      acceptCurrencyMismatch: false,
      actor: { userId: actor.auth.user.id, allowedSiteIds: undefined },
      stepUp: null,
    })));

  it('refuses a generic move out of a holding org', async () => {
    const parked = await seedParked();
    const err = await runEngine({ deviceId: parked.id, sourceOrgId: pool.orgId, targetOrgId, targetSiteId, via: 'generic_move' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DevicePoolMembershipRefusedError);
    expect((err as DevicePoolMembershipRefusedError).code).toBe('POOL_EXIT_REQUIRES_ASSIGNMENT');
    expect((await deviceRow(parked.id)).orgId).toBe(pool.orgId);
  });

  it.each(['generic_move', 'pool_assignment'] as const)('refuses any move into a holding org (via %s)', async (via) => {
    const [regular] = await getTestDb().insert(devices).values({
      orgId: targetOrgId, siteId: targetSiteId, agentId: `regular-${randomUUID()}`.slice(0, 64), hostname: 'regular',
      osType: 'linux', osVersion: 'test', architecture: 'x64', agentVersion: 'test',
    }).returning({ id: devices.id });
    const err = await runEngine({ deviceId: regular!.id, sourceOrgId: targetOrgId, targetOrgId: pool.orgId, targetSiteId: pool.siteId, via })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DevicePoolMembershipRefusedError);
    expect((err as DevicePoolMembershipRefusedError).code).toBe('POOL_ENTRY_FORBIDDEN');
    expect((await deviceRow(regular!.id)).orgId).toBe(targetOrgId);
  });
});

describe('latency — bulk assignment', () => {
  it('assigns 25 parked devices under one batch within the ceiling', async () => {
    const parked = [];
    for (let i = 0; i < 25; i += 1) parked.push(await seedParked());
    const started = performance.now();
    const out = await assignParkedDevicesBulk({
      actor,
      items: parked.map((p) => ({ deviceId: p.id, targetOrgId, targetSiteId })),
      stepUp: null,
      audit: request,
    });
    const elapsedMs = performance.now() - started;
    process.stdout.write(`[parkedAssignment] bulk-25 assignment latency: ${elapsedMs.toFixed(1)} ms (${(elapsedMs / 25).toFixed(1)} ms/device)\n`);
    expect(elapsedMs).toBeLessThan(30_000);
    expect(out.ok && out.results.every((r) => r.ok)).toBe(true);
    const moved = await getTestDb().select({ id: devices.id }).from(devices).where(eq(devices.orgId, targetOrgId));
    expect(moved).toHaveLength(25);
    const ledger = await getTestDb().select().from(devicePoolAssignmentEvents)
      .where(and(eq(devicePoolAssignmentEvents.partnerId, partnerId), eq(devicePoolAssignmentEvents.eventType, 'assigned')));
    expect(ledger).toHaveLength(25);
    expect(ledger.every((r) => r.assignmentMethod === 'bulk')).toBe(true);
  }, 60_000);
});

describe('session revocation mid-batch', () => {
  it('stops the remaining items once the signed-in session is revoked', async () => {
    const parked = [await seedParked(), await seedParked(), await seedParked()];
    const items = parked.map((p) => ({ deviceId: p.id, targetOrgId, targetSiteId }));
    const binding: StepUpGrantBinding = {
      userId: actor.auth.user.id,
      operation: 'parked_device_assign_bulk',
      authEpoch: actor.auth.token!.aep!,
      mfaEpoch: actor.auth.token!.mep!,
      sid: actor.auth.token!.sid!,
      resourceDigest: parkedBulkAssignResourceDigest(items),
    };
    const grantId = await mintStepUpGrant(binding);
    let locks = 0;
    const out = await assignParkedDevicesBulk(
      { actor, items, stepUp: { grantId: grantId!, binding }, audit: request },
      {
        hooks: {
          // Before the second device re-checks the session, the user signs out.
          afterDeviceLock: async () => {
            locks += 1;
            if (locks === 2) {
              await getTestDb().update(refreshTokenFamilies)
                .set({ revokedAt: new Date(), revokedReason: 'logout' })
                .where(eq(refreshTokenFamilies.familyId, binding.sid));
            }
          },
        },
      },
    );
    expect(out.ok && out.results.map((r) => (r.ok ? 'ok' : r.code))).toEqual(['ok', 'STEP_UP_REQUIRED', 'STEP_UP_REQUIRED']);
    expect((await deviceRow(parked[0]!.id)).orgId).toBe(targetOrgId);
    expect((await deviceRow(parked[1]!.id)).orgId).toBe(pool.orgId);
    expect((await deviceRow(parked[2]!.id)).orgId).toBe(pool.orgId);
  });
});

describe('HTTP routes — self-managed DB context, end to end', () => {
  it('lists, assigns one and assigns a batch through the real routes with real step-up grants', async () => {
    const env = await setupTestEnvironment({ scope: 'partner' });
    const holding = await seedHoldingOrg(env.partner.id);
    const sid = await seedSession(env.user.id);
    const payload: Omit<TokenPayload, 'type'> = {
      sub: env.user.id, email: env.user.email, roleId: env.role.id, orgId: null,
      partnerId: env.partner.id, scope: 'partner', mfa: true, aep: 1, mep: 1, sid,
    };
    const token = await createAccessToken(payload);
    const app = new Hono();
    app.route('/api/v1/pre-assignment', preAssignmentRoutes);
    const call = (method: string, path: string, body?: unknown) => app.request(`/api/v1/pre-assignment${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    pool = holding;
    const one = await seedParked();
    const two = await seedParked();
    const three = await seedParked();

    const list = await call('GET', '/devices');
    expect(list.status, await list.clone().text()).toBe(200);
    const listed = ((await list.json()) as { devices: Array<{ id: string }> }).devices.map((d) => d.id).sort();
    expect(listed).toEqual([one.id, two.id, three.id].sort());

    const orgId = env.organization.id;
    const siteId = env.site.id;
    const mint = async (operation: 'parked_device_assign' | 'parked_device_assign_bulk', resourceDigest: string) =>
      (await mintStepUpGrant({ userId: env.user.id, operation, authEpoch: 1, mfaEpoch: 1, sid, resourceDigest }))!;

    const single = await call('POST', `/devices/${one.id}/assign`, {
      orgId, siteId, possessionConfirmed: true,
      stepUpGrant: await mint('parked_device_assign', parkedAssignResourceDigest({ deviceId: one.id, targetOrgId: orgId, targetSiteId: siteId })),
    });
    expect(single.status, await single.clone().text()).toBe(200);

    const items = [two, three].map((d) => ({ deviceId: d.id, targetOrgId: orgId, targetSiteId: siteId }));
    const bulk = await call('POST', '/devices/assign-bulk', {
      items: items.map((i) => ({ deviceId: i.deviceId, orgId, siteId })),
      possessionConfirmed: true,
      stepUpGrant: await mint('parked_device_assign_bulk', parkedBulkAssignResourceDigest(items)),
    });
    expect(bulk.status, await bulk.clone().text()).toBe(200);
    expect(await bulk.json()).toEqual({ results: [{ deviceId: two.id, ok: true }, { deviceId: three.id, ok: true }] });

    for (const d of [one, two, three]) expect((await deviceRow(d.id)).orgId).toBe(orgId);
    expect((await (await call('GET', '/devices')).json() as { devices: unknown[] }).devices).toEqual([]);
  });
});
