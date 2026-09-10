/**
 * #2787 — device restore / permanent delete against REAL Postgres.
 *
 * The unit suite (`services/deviceLifecycle.test.ts`) drives a fake tx and can
 * therefore prove the STATEMENT ORDER but not what the database does with it.
 * Three properties live entirely in Postgres's evaluation rules and, before
 * this file, were argued in comments rather than executed:
 *
 *   - `uninstall_reasons @> ARRAY['device_remove']::text[]` against a row the
 *     Remove path actually wrote, with `device_remove_expires_at > now()`
 *     evaluated by the DATABASE clock. A refusal that misses a live uninstall
 *     is a purge that destroys the only command that will ever clean the
 *     endpoint.
 *   - the status re-check under `SELECT ... FOR UPDATE`, which is what makes
 *     a purge lose to a Restore that committed after the route's pre-flight
 *     check (the TOCTOU this wave closes).
 *   - the cascade actually completing over the ~40 real child tables, so
 *     "purge succeeded" means the row is gone rather than "no statement threw
 *     in a mock".
 *
 * Deliberately NOT `it.runIf(...)`: a skipped guard is indistinguishable from
 * a passing one in a CI log. If the database is missing these fail loudly.
 *
 * Run (note: NO `--` before the path — `pnpm ... test:integration -- <path>`
 * silently runs the whole integration suite instead of filtering):
 *   pnpm test-stack up
 *   cd apps/api && pnpm exec vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/deviceLifecycle.integration.test.ts
 */
import './setup';

import { describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';

import { getTestDb } from './setup';
import {
  createOrganization,
  createPartner,
  createSite,
  createUser,
  setupTestEnvironment,
} from './db-utils';
import { db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import {
  alerts,
  deviceCommands,
  deviceLinkGroups,
  devices,
  organizationUsers,
  sites,
} from '../../db/schema';
import { queueDeviceUninstall } from '../../services/deviceUninstallDrain';
import { purgeRemovedDevice, restoreRemovedDevice } from '../../services/deviceLifecycle';
import {
  deleteLinkGroup,
  dissolveLinkGroupIfBelowMinimum,
  lockAndAuthorizeLinkGroupMutation,
} from '../../services/deviceLinkGroups';
import {
  processDeviceBulkPurgeJob,
  type DeviceBulkPurgeJobPayload,
  type DeviceBulkPurgeResult,
} from '../../jobs/deviceBulkPurge';
import { linksRoutes } from '../../routes/devices/links';
import { clearPermissionCache } from '../../services/permissions';
import { createAccessToken } from '../../services/jwt';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let deviceCounter = 0;

interface Tenant {
  partnerId: string;
  orgId: string;
  siteId: string;
  userId: string;
  userEmail: string;
}

async function seedTenant(): Promise<Tenant> {
  const partner = await createPartner({ status: 'active' });
  const org = await createOrganization({ partnerId: partner.id, status: 'active' });
  const site = await createSite({ orgId: org.id });
  const user = await createUser({ partnerId: partner.id, orgId: org.id });
  return {
    partnerId: partner.id,
    orgId: org.id,
    siteId: site.id,
    userId: user.id,
    userEmail: user.email,
  };
}

async function seedDevice(
  orgId: string,
  siteId: string,
  status: 'online' | 'offline' | 'decommissioned' = 'decommissioned',
): Promise<{ id: string; hostname: string }> {
  deviceCounter += 1;
  const suffix = `${Date.now()}-${deviceCounter}-${Math.random().toString(36).slice(2, 8)}`;
  const hostname = `host-2787-${suffix}`;
  const [row] = await getTestDb()
    .insert(devices)
    .values({
      orgId,
      siteId,
      agentId: `agent-2787-${suffix}`,
      hostname,
      osType: 'windows',
      osVersion: '11',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status,
      agentTokenHash: createHash('sha256').update(`brz_2787_${suffix}`).digest('hex'),
      enrolledAt: new Date(),
    })
    .returning({ id: devices.id });
  if (!row) throw new Error('seedDevice: insert returned no row');
  return { id: row.id, hostname };
}

async function deviceExists(deviceId: string): Promise<boolean> {
  const rows = await getTestDb().select({ id: devices.id }).from(devices).where(eq(devices.id, deviceId));
  return rows.length > 0;
}

async function deviceStatus(deviceId: string): Promise<string | undefined> {
  const [row] = await getTestDb()
    .select({ status: devices.status })
    .from(devices)
    .where(eq(devices.id, deviceId));
  return row?.status;
}

async function seedMixedSiteLinkGroup(tenant: Tenant, tag: string) {
  const [hiddenSite] = await getTestDb()
    .insert(sites)
    .values({ orgId: tenant.orgId, name: `Hidden site ${tag}-${Date.now()}` })
    .returning({ id: sites.id });
  if (!hiddenSite) throw new Error('seedMixedSiteLinkGroup: hidden site insert returned no row');
  const visible = await seedDevice(tenant.orgId, tenant.siteId);
  const hidden = await seedDevice(tenant.orgId, hiddenSite.id);
  const [group] = await getTestDb()
    .insert(deviceLinkGroups)
    .values({ orgId: tenant.orgId, name: `mixed-${tag}` })
    .returning({ id: deviceLinkGroups.id });
  if (!group) throw new Error('seedMixedSiteLinkGroup: group insert returned no row');
  await getTestDb()
    .update(devices)
    .set({ linkGroupId: group.id })
    .where(inArray(devices.id, [visible.id, hidden.id]));
  return { groupId: group.id, visible, hidden, hiddenSiteId: hiddenSite.id };
}

async function linkedState(deviceIds: string[]) {
  return getTestDb()
    .select({ id: devices.id, linkGroupId: devices.linkGroupId })
    .from(devices)
    .where(inArray(devices.id, deviceIds));
}

/** Wait until another backend is observably queued behind `blockerPid`. */
async function waitForBackendBlockedBy(blockerPid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [row] = await getTestDb().execute<{ blocked: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_stat_activity AS waiting
         WHERE waiting.pid <> pg_catalog.pg_backend_pid()
           AND ${blockerPid} = ANY(pg_catalog.pg_blocking_pids(waiting.pid))
      ) AS blocked
    `);
    if (row?.blocked) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`no backend blocked behind ${blockerPid} within five seconds`);
}

/** Queue the durable `device_remove` uninstall exactly the Remove route does. */
async function queueRemoveUninstall(deviceId: string, actorUserId: string): Promise<void> {
  await withSystemDbAccessContext(() =>
    db.transaction(async (tx) => {
      const result = await queueDeviceUninstall(tx, deviceId, actorUserId);
      if (!result.queued && !result.mergedIntoExisting) {
        throw new Error('queueRemoveUninstall: nothing was queued — fixture is not exercising the guard');
      }
    }),
  );
}

/** Org-scoped RLS context, the shape `authMiddleware` builds for an org-token request. */
function orgContext(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
  };
}

// ---------------------------------------------------------------------------

describe('deviceLifecycle (integration)', () => {
  it('omits hidden-only groups, 404s their direct read, and preserves a mixed visible subset', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const hiddenSite = await createSite({ orgId: env.organization.id });
    const tenant: Tenant = {
      partnerId: env.partner.id,
      orgId: env.organization.id,
      siteId: env.site.id,
      userId: env.user.id,
      userEmail: env.user.email,
    };
    const visible = await seedDevice(tenant.orgId, tenant.siteId, 'offline');
    const mixedHidden = await seedDevice(tenant.orgId, hiddenSite.id, 'offline');
    const hiddenA = await seedDevice(tenant.orgId, hiddenSite.id, 'offline');
    const hiddenB = await seedDevice(tenant.orgId, hiddenSite.id, 'offline');
    const [mixedGroup, hiddenGroup] = await getTestDb()
      .insert(deviceLinkGroups)
      .values([
        { orgId: tenant.orgId, name: 'mixed-visible-group' },
        { orgId: tenant.orgId, name: 'hidden-only-group' },
      ])
      .returning({ id: deviceLinkGroups.id, name: deviceLinkGroups.name });
    if (!mixedGroup || !hiddenGroup) throw new Error('link group inserts returned no rows');
    await getTestDb().update(devices).set({ linkGroupId: mixedGroup.id })
      .where(inArray(devices.id, [visible.id, mixedHidden.id]));
    await getTestDb().update(devices).set({ linkGroupId: hiddenGroup.id })
      .where(inArray(devices.id, [hiddenA.id, hiddenB.id]));
    await getTestDb()
      .update(organizationUsers)
      .set({ siteIds: [tenant.siteId] })
      .where(eq(organizationUsers.userId, tenant.userId));
    await clearPermissionCache(tenant.userId);

    const app = new Hono();
    app.route('/devices', linksRoutes);
    const headers = { Authorization: `Bearer ${env.token}` };
    const list = await app.request('/devices/link-groups', { headers });
    expect(list.status).toBe(200);
    const listBody = await list.json() as {
      data: Array<{ id: string; name: string | null; members: Array<{ deviceId: string }> }>;
    };
    expect(listBody.data.map((group) => group.id)).toEqual([mixedGroup.id]);
    expect(listBody.data[0]?.members.map((member) => member.deviceId)).toEqual([visible.id]);
    expect(JSON.stringify(listBody)).not.toContain('hidden-only-group');

    const hiddenRead = await app.request(`/devices/link-groups/${hiddenGroup.id}`, { headers });
    expect(hiddenRead.status).toBe(404);
    const mixedRead = await app.request(`/devices/link-groups/${mixedGroup.id}`, { headers });
    expect(mixedRead.status).toBe(200);
    expect((await mixedRead.json() as { members: Array<{ deviceId: string }> }).members)
      .toEqual([expect.objectContaining({ deviceId: visible.id })]);
  });

  it('re-checks every create target after preflight and rolls back a post-preflight site move', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const hiddenSite = await createSite({ orgId: env.organization.id });
    const first = await seedDevice(env.organization.id, env.site.id, 'offline');
    const moved = await seedDevice(env.organization.id, env.site.id, 'offline');
    await getTestDb()
      .update(organizationUsers)
      .set({ siteIds: [env.site.id] })
      .where(eq(organizationUsers.userId, env.user.id));
    await clearPermissionCache(env.user.id);

    // The create route is MFA-gated; setupTestEnvironment intentionally mints
    // mfa:false, so bind an MFA-satisfied token to the same live identity and
    // epochs. Without this, the supposed race test exits at requireMfa before
    // touching either preflight or the transactional row lock.
    const mfaToken = await createAccessToken({
      sub: env.user.id,
      email: env.user.email,
      roleId: env.role.id,
      orgId: env.organization.id,
      partnerId: env.partner.id,
      scope: 'organization',
      mfa: true,
      aep: 1,
      mep: 1,
      sid: randomUUID(),
    });

    let releaseMove!: () => void;
    const holdMove = new Promise<void>((resolve) => { releaseMove = resolve; });
    let announceLocked!: (pid: number) => void;
    const moveLocked = new Promise<number>((resolve) => { announceLocked = resolve; });
    const move = getTestDb().transaction(async (tx) => {
      const [backend] = await tx.execute<{ pid: number }>(sql`
        SELECT pg_catalog.pg_backend_pid()::int AS pid
      `);
      if (!backend) throw new Error('site-move backend pid missing');
      await tx.update(devices).set({ siteId: hiddenSite.id }).where(eq(devices.id, moved.id));
      announceLocked(backend.pid);
      await holdMove;
    });
    const moveBackendPid = await moveLocked;

    const app = new Hono();
    app.route('/devices', linksRoutes);
    const groupName = `post-preflight-${Date.now()}`;
    const responsePromise = Promise.resolve(app.request('/devices/link-groups', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${mfaToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ deviceIds: [first.id, moved.id], name: groupName }),
    }));

    // Prove the route completed its non-locking preflight and is genuinely
    // waiting on the transactional target-row lock. A fixed delay can release
    // the move before the request reaches FOR UPDATE and accidentally test only
    // the ordinary preflight denial rather than the post-preflight race.
    const observed = await Promise.race([
      waitForBackendBlockedBy(moveBackendPid).then(() => ({ kind: 'blocked' as const })),
      responsePromise.then(async (earlyResponse) => ({
        kind: 'response' as const,
        status: earlyResponse.status,
        body: await earlyResponse.clone().text(),
      })),
    ]);
    try {
      expect(observed, 'create request completed before waiting on the held target-row lock')
        .toEqual({ kind: 'blocked' });
    } finally {
      // Always release the fixture lock so a failed assertion cannot strand the
      // suite's teardown TRUNCATE behind this transaction.
      releaseMove();
      await move;
    }
    const response = await responsePromise;

    expect(response.status).toBe(403);
    expect(await getTestDb().select({ id: deviceLinkGroups.id }).from(deviceLinkGroups)
      .where(and(eq(deviceLinkGroups.orgId, env.organization.id), eq(deviceLinkGroups.name, groupName))))
      .toEqual([]);
    expect(await linkedState([first.id, moved.id])).toEqual(expect.arrayContaining([
      { id: first.id, linkGroupId: null },
      { id: moved.id, linkGroupId: null },
    ]));
  }, 15_000);

  it('rolls back an implicit dissolve when a restricted caller cannot access the survivor site', async () => {
    const tenant = await seedTenant();
    const linked = await seedMixedSiteLinkGroup(tenant, 'dissolve');

    await expect(
      withDbAccessContext(orgContext(tenant.orgId), () =>
        db.transaction(async (tx) => {
          await tx
            .update(devices)
            .set({ linkGroupId: null, linkGroupRole: null })
            .where(eq(devices.id, linked.visible.id));
          await dissolveLinkGroupIfBelowMinimum(tx, linked.groupId, [tenant.siteId]);
        }),
      ),
    ).rejects.toMatchObject({ name: 'LinkGroupSiteAccessError' });

    expect(await linkedState([linked.visible.id, linked.hidden.id])).toEqual(
      expect.arrayContaining([
        { id: linked.visible.id, linkGroupId: linked.groupId },
        { id: linked.hidden.id, linkGroupId: linked.groupId },
      ]),
    );
  });

  it('denies a mixed-site group delete as breeze_app without unlinking either member', async () => {
    const tenant = await seedTenant();
    const linked = await seedMixedSiteLinkGroup(tenant, 'delete');

    await expect(
      withDbAccessContext(orgContext(tenant.orgId), () =>
        db.transaction((tx) => deleteLinkGroup(tx, linked.groupId, [tenant.siteId])),
      ),
    ).rejects.toMatchObject({ name: 'LinkGroupSiteAccessError' });

    expect(await linkedState([linked.visible.id, linked.hidden.id])).toEqual(
      expect.arrayContaining([
        { id: linked.visible.id, linkGroupId: linked.groupId },
        { id: linked.hidden.id, linkGroupId: linked.groupId },
      ]),
    );
  });

  it('serializes competing group mutations on deterministic member locks', async () => {
    const tenant = await seedTenant();
    const linked = await seedMixedSiteLinkGroup(tenant, 'lock-race');
    let releaseFirst!: () => void;
    const holdFirst = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let announceLocked!: () => void;
    const firstLocked = new Promise<void>((resolve) => { announceLocked = resolve; });
    let secondAcquired = false;

    const first = runOutsideDbContext(() => withDbAccessContext(orgContext(tenant.orgId), () =>
      db.transaction(async (tx) => {
        await lockAndAuthorizeLinkGroupMutation(
          tx,
          linked.groupId,
          [tenant.siteId, linked.hiddenSiteId],
        );
        announceLocked();
        await holdFirst;
      })));
    await firstLocked;

    const second = runOutsideDbContext(() => withDbAccessContext(orgContext(tenant.orgId), () =>
      db.transaction(async (tx) => {
        await lockAndAuthorizeLinkGroupMutation(
          tx,
          linked.groupId,
          [tenant.siteId, linked.hiddenSiteId],
        );
        secondAcquired = true;
      })));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(secondAcquired).toBe(false);

    releaseFirst();
    await Promise.all([first, second]);
    expect(secondAcquired).toBe(true);
  });

  it('rolls back a single-device purge when it would unlink a hidden-site survivor', async () => {
    const tenant = await seedTenant();
    const linked = await seedMixedSiteLinkGroup(tenant, 'single-purge');

    await expect(
      withSystemDbAccessContext(() =>
        db.transaction((tx) => purgeRemovedDevice(tx, linked.visible.id, [tenant.siteId])),
      ),
    ).rejects.toMatchObject({
      code: 'STATE_CHANGED',
      message: 'Device access or linked state changed before deletion',
      status: 409,
    });

    expect(await deviceExists(linked.visible.id)).toBe(true);
    expect(await linkedState([linked.visible.id, linked.hidden.id])).toEqual(
      expect.arrayContaining([
        { id: linked.visible.id, linkGroupId: linked.groupId },
        { id: linked.hidden.id, linkGroupId: linked.groupId },
      ]),
    );
  });

  it('denies a permanent-delete target whose site changed after request preflight', async () => {
    const tenant = await seedTenant();
    const target = await seedDevice(tenant.orgId, tenant.siteId, 'decommissioned');
    const [hiddenSite] = await getTestDb()
      .insert(sites)
      .values({ orgId: tenant.orgId, name: `Post-preflight hidden ${Date.now()}` })
      .returning({ id: sites.id });
    if (!hiddenSite) throw new Error('hidden site insert returned no row');

    // Models a site move committed after the route/producer's friendly access
    // check but before the system-scoped purge acquires the target row lock.
    await getTestDb()
      .update(devices)
      .set({ siteId: hiddenSite.id })
      .where(eq(devices.id, target.id));

    await expect(
      withSystemDbAccessContext(() =>
        db.transaction((tx) => purgeRemovedDevice(tx, target.id, [tenant.siteId])),
      ),
    ).rejects.toMatchObject({ code: 'SITE_ACCESS_DENIED', status: 403 });
    expect(await deviceExists(target.id)).toBe(true);
  });

  it('re-applies the serialized site ceiling in the bulk worker and leaves the target intact', async () => {
    const tenant = await seedTenant();
    const linked = await seedMixedSiteLinkGroup(tenant, 'bulk-purge');
    const jobId = '77777777-7777-4777-8777-777777777777';

    const result = (await processDeviceBulkPurgeJob({
      name: 'device-bulk-purge-v2',
      id: `device-bulk-purge-v2-${jobId}`,
      data: {
        jobId,
        targets: [{
          deviceId: linked.visible.id,
          orgId: tenant.orgId,
          hostname: linked.visible.hostname,
        }],
        authorization: {
          version: 1,
          siteAccess: { mode: 'restricted', allowedSiteIds: [tenant.siteId] },
        },
        actorUserId: tenant.userId,
        actorEmail: tenant.userEmail,
        partnerId: tenant.partnerId,
      } satisfies DeviceBulkPurgeJobPayload,
      updateProgress: async () => {},
    } as never)) as DeviceBulkPurgeResult;

    expect(result).toEqual({
      purged: [],
      skipped: [{ deviceId: linked.visible.id, code: 'STATE_CHANGED' }],
    });
    expect(await deviceExists(linked.visible.id)).toBe(true);
    expect(await deviceExists(linked.hidden.id)).toBe(true);
  });

  it('structurally rejects a null site and allows an unrestricted mixed-site delete', async () => {
    const tenant = await seedTenant();
    const visible = await seedDevice(tenant.orgId, tenant.siteId, 'offline');
    const unassigned = await seedDevice(tenant.orgId, tenant.siteId, 'offline');
    let nullSiteError: unknown;
    try {
      await getTestDb().update(devices).set({ siteId: sql`NULL` }).where(eq(devices.id, unassigned.id));
    } catch (err) {
      nullSiteError = err;
    }
    expect((nullSiteError as { cause?: { code?: string } } | undefined)?.cause?.code).toBe('23502');
    const [otherSite] = await getTestDb()
      .insert(sites)
      .values({ orgId: tenant.orgId, name: `Unrestricted sibling ${Date.now()}` })
      .returning({ id: sites.id });
    if (!otherSite) throw new Error('other site insert returned no row');
    await getTestDb().update(devices).set({ siteId: otherSite.id }).where(eq(devices.id, unassigned.id));
    const [group] = await getTestDb()
      .insert(deviceLinkGroups)
      .values({ orgId: tenant.orgId, name: 'null-site-member' })
      .returning({ id: deviceLinkGroups.id });
    if (!group) throw new Error('group insert returned no row');
    await getTestDb()
      .update(devices)
      .set({ linkGroupId: group.id })
      .where(inArray(devices.id, [visible.id, unassigned.id]));

    await withDbAccessContext(orgContext(tenant.orgId), () =>
      db.transaction((tx) => deleteLinkGroup(tx, group.id)),
    );
    expect(await linkedState([visible.id, unassigned.id])).toEqual(
      expect.arrayContaining([
        { id: visible.id, linkGroupId: null },
        { id: unassigned.id, linkGroupId: null },
      ]),
    );
  });

  it('purge refuses while a device_remove uninstall is pending, and the device row survives', async () => {
    const tenant = await seedTenant();
    const device = await seedDevice(tenant.orgId, tenant.siteId);
    await queueRemoveUninstall(device.id, tenant.userId);

    // Positive control on the fixture: the refusal must be caused by a row the
    // real Remove path wrote, not by an empty table making every arm vacuous.
    const queued = await getTestDb()
      .select({ id: deviceCommands.id, reasons: deviceCommands.uninstallReasons })
      .from(deviceCommands)
      .where(eq(deviceCommands.deviceId, device.id));
    expect(queued).toHaveLength(1);
    expect(queued[0]!.reasons).toContain('device_remove');

    await expect(
      withSystemDbAccessContext(() => db.transaction((tx) => purgeRemovedDevice(tx, device.id))),
    ).rejects.toMatchObject({ code: 'UNINSTALL_PENDING' });

    // The whole point: `device_commands` is IN the device cascade, so a purge
    // that ran here would have destroyed the uninstall as well as the device.
    expect(await deviceExists(device.id)).toBe(true);
    const stillQueued = await getTestDb()
      .select({ id: deviceCommands.id, status: deviceCommands.status })
      .from(deviceCommands)
      .where(eq(deviceCommands.deviceId, device.id));
    expect(stillQueued).toHaveLength(1);
    expect(stillQueued[0]!.status).toBe('pending');
  });

  it('purge proceeds once the pending uninstall has been cancelled by a restore + re-remove', async () => {
    const tenant = await seedTenant();
    const device = await seedDevice(tenant.orgId, tenant.siteId);
    await queueRemoveUninstall(device.id, tenant.userId);

    // Restore cancels the device_remove row (and clears its deadline)...
    const restored = await withSystemDbAccessContext(() =>
      db.transaction((tx) => restoreRemovedDevice(tx, device.id)),
    );
    expect(restored.uninstallAlreadyDispatched).toBe(false);
    expect(await deviceStatus(device.id)).toBe('offline');

    // ...so a Remove that leaves the agent installed, then a purge, is allowed.
    await withSystemDbAccessContext(() =>
      db.execute(sql`UPDATE devices SET status = 'decommissioned' WHERE id = ${device.id}`),
    );
    await withSystemDbAccessContext(() => db.transaction((tx) => purgeRemovedDevice(tx, device.id)));
    expect(await deviceExists(device.id)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // NEGATIVE CONTROLS on the refusal predicate.
  //
  // The refusal above only earns its keep if it is NARROW. A predicate that
  // fired on "any pending self_uninstall" would wedge permanent delete forever
  // behind an expired row, and — the incident `deviceUninstallDrain.ts`'s
  // module doc exists to prevent — behind an abuse-suspension or
  // tenant-offboarding row that this feature does not own.
  //
  // Each case differs from a genuinely-draining row in EXACTLY ONE arm, so a
  // pass here pins that arm specifically rather than "some row shape".
  // -------------------------------------------------------------------------

  it('purge PROCEEDS when the device_remove uninstall deadline has already passed', async () => {
    const tenant = await seedTenant();
    const device = await seedDevice(tenant.orgId, tenant.siteId);
    await queueRemoveUninstall(device.id, tenant.userId);

    // Backdate ONLY the deadline. Reason, type and status still match a
    // draining row, so this isolates the `device_remove_expires_at > now()`
    // arm — and `now()` is the DATABASE clock, which is why this case cannot
    // be argued on compiled SQL.
    await withSystemDbAccessContext(() =>
      db.execute(sql`
        UPDATE device_commands
           SET device_remove_expires_at = now() - interval '1 hour'
         WHERE device_id = ${device.id} AND type = 'self_uninstall'
      `),
    );

    // Control: the row is still pending and still carries the reason, so the
    // only thing standing between this and a refusal is the deadline.
    const [row] = (await withSystemDbAccessContext(() =>
      db.execute(sql`
        SELECT status, uninstall_reasons FROM device_commands
         WHERE device_id = ${device.id} AND type = 'self_uninstall'
      `),
    )) as unknown as Array<{ status: string; uninstall_reasons: string[] }>;
    expect(row!.status).toBe('pending');
    expect(row!.uninstall_reasons).toContain('device_remove');

    await withSystemDbAccessContext(() => db.transaction((tx) => purgeRemovedDevice(tx, device.id)));
    expect(await deviceExists(device.id)).toBe(false);
  });

  it('purge PROCEEDS when the only pending uninstall belongs to tenant offboarding', async () => {
    const tenant = await seedTenant();
    const device = await seedDevice(tenant.orgId, tenant.siteId);

    // A row that is draining in every respect EXCEPT the reason: pending, the
    // right type, and an UNEXPIRED deadline. That isolates the
    // `uninstall_reasons @> ARRAY['device_remove']` arm. A predicate keyed on
    // bare presence of a pending self_uninstall would refuse here — and would
    // also sweep up abuse-suspension rows, which is the incident
    // deviceUninstallDrain.ts was written to prevent.
    await withSystemDbAccessContext(() =>
      db.insert(deviceCommands).values({
        deviceId: device.id,
        type: 'self_uninstall',
        payload: { removeConfig: true },
        status: 'pending',
        targetRole: 'agent',
        uninstallReasons: ['tenant_offboarding'],
        deviceRemoveExpiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
      }),
    );

    await withSystemDbAccessContext(() => db.transaction((tx) => purgeRemovedDevice(tx, device.id)));
    expect(await deviceExists(device.id)).toBe(false);
  });

  it('purge racing restore: the purge that commits second loses cleanly (NOT_REMOVED)', async () => {
    const tenant = await seedTenant();
    const device = await seedDevice(tenant.orgId, tenant.siteId);

    // Restore commits first. Before #2787 the permanent-delete route had
    // already read `status = 'decommissioned'` outside its transaction and
    // never re-checked, so this device was purged anyway.
    await withSystemDbAccessContext(() => db.transaction((tx) => restoreRemovedDevice(tx, device.id)));

    await expect(
      withSystemDbAccessContext(() => db.transaction((tx) => purgeRemovedDevice(tx, device.id))),
    ).rejects.toMatchObject({ code: 'NOT_REMOVED' });

    expect(await deviceExists(device.id)).toBe(true);
    expect(await deviceStatus(device.id)).toBe('offline');
  });

  it('purge succeeds on a removed device with no pending uninstall and removes the row', async () => {
    const tenant = await seedTenant();
    const device = await seedDevice(tenant.orgId, tenant.siteId);

    const result = await withSystemDbAccessContext(() =>
      db.transaction((tx) => purgeRemovedDevice(tx, device.id)),
    );

    expect(result.linkGroupDissolved).toBe(false);
    expect(await deviceExists(device.id)).toBe(false);
  });

  it('purge reports NOT_FOUND for a device id that does not exist', async () => {
    await expect(
      withSystemDbAccessContext(() =>
        db.transaction((tx) => purgeRemovedDevice(tx, '11111111-1111-4111-8111-111111111111')),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  // -------------------------------------------------------------------------
  // Bulk purge worker (#2787 Task 5) — authorisation is re-derived per device
  // under the lock, so a device that MOVED ORG between the operator's confirm
  // and the worker's execution must never be deleted under the stale
  // authorisation the payload carries.
  // -------------------------------------------------------------------------
  it('bulk purge worker skips a device whose org changed after enqueue (ORG_CHANGED)', async () => {
    const tenant = await seedTenant();
    const otherOrg = await createOrganization({ partnerId: tenant.partnerId, status: 'active' });
    const moved = await seedDevice(tenant.orgId, tenant.siteId);
    const stayed = await seedDevice(tenant.orgId, tenant.siteId);

    const payload: DeviceBulkPurgeJobPayload = {
      jobId: '22222222-2222-4222-8222-222222222222',
      targets: [
        { deviceId: moved.id, orgId: tenant.orgId, hostname: moved.hostname },
        { deviceId: stayed.id, orgId: tenant.orgId, hostname: stayed.hostname },
      ],
      authorization: { version: 1, siteAccess: { mode: 'unrestricted' } },
      actorUserId: tenant.userId,
      actorEmail: tenant.userEmail,
      partnerId: tenant.partnerId,
    };

    // The move happens AFTER the payload was built — exactly the window the
    // re-check exists for. site_id goes with it: sites are org-scoped.
    const otherSite = await createSite({ orgId: otherOrg.id });
    await withSystemDbAccessContext(() =>
      db.execute(
        sql`UPDATE devices SET org_id = ${otherOrg.id}::uuid, site_id = ${otherSite.id}::uuid WHERE id = ${moved.id}`,
      ),
    );

    const progress: Array<{ done: number; total: number }> = [];
    const result = (await processDeviceBulkPurgeJob({
      name: 'device-bulk-purge-v2',
      id: `device-bulk-purge-v2-${payload.jobId}`,
      data: payload,
      updateProgress: async (p: unknown) => {
        progress.push(p as { done: number; total: number });
      },
    } as never)) as DeviceBulkPurgeResult;

    expect(result.skipped).toContainEqual({ deviceId: moved.id, code: 'ORG_CHANGED' });
    expect(result.purged).toEqual([stayed.id]);
    // Skipped means SKIPPED, not "deleted with a warning".
    expect(await deviceExists(moved.id)).toBe(true);
    expect(await deviceExists(stayed.id)).toBe(false);
    expect(progress).toEqual([
      { done: 1, total: 2 },
      { done: 2, total: 2 },
    ]);
  });

  it('bulk purge worker skips a device whose uninstall is still pending', async () => {
    const tenant = await seedTenant();
    const device = await seedDevice(tenant.orgId, tenant.siteId);
    await queueRemoveUninstall(device.id, tenant.userId);

    const result = (await processDeviceBulkPurgeJob({
      name: 'device-bulk-purge-v2',
      id: 'device-bulk-purge-v2-33333333-3333-4333-8333-333333333333',
      data: {
        jobId: '33333333-3333-4333-8333-333333333333',
        targets: [{ deviceId: device.id, orgId: tenant.orgId, hostname: device.hostname }],
        authorization: { version: 1, siteAccess: { mode: 'unrestricted' } },
        actorUserId: tenant.userId,
        actorEmail: tenant.userEmail,
        partnerId: tenant.partnerId,
      } satisfies DeviceBulkPurgeJobPayload,
      updateProgress: async () => {},
    } as never)) as DeviceBulkPurgeResult;

    expect(result.purged).toEqual([]);
    expect(result.skipped).toEqual([{ deviceId: device.id, code: 'UNINSTALL_PENDING' }]);
    expect(await deviceExists(device.id)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // #5023 wave 05 — single permanent delete must run the cascade in a SYSTEM
  // db context, matching this file's own `withSystemDbAccessContext` calls
  // above and `jobs/deviceBulkPurge.ts`'s `purgeOne`. Before this wave, the
  // route ran the cascade under the CALLER's org-scoped context instead
  // (reproduced directly here via `orgContext`, without going through HTTP —
  // this file already drives `purgeRemovedDevice` the same way every test
  // above does).
  // -------------------------------------------------------------------------
  it('an org-scoped cascade context leaves an RLS-hidden cascade row behind and fails the whole delete; a system-scoped context (matching the route since wave 05) removes it cleanly', async () => {
    const tenant = await seedTenant();
    const device = await seedDevice(tenant.orgId, tenant.siteId);

    // Poison the cascade with a row `tenant.orgId`'s own context cannot see:
    // an `alerts` row stamped with a DIFFERENT org. Nothing in normal
    // operation produces this shape (the alerts service always stamps the
    // triggering device's own org) — it stands in for the general hazard
    // `services/deviceDeletion.ts` documents for `abuse_endpoint_fingerprints`
    // (a cascade table an RLS policy can hide from the deleting context),
    // reproduced with a table whose FK is NOT `ON DELETE SET NULL`/`CASCADE`
    // (`alerts_device_id_devices_id_fk` is NO ACTION — verified against this
    // stack's live schema), so an invisible row actually BLOCKS the parent
    // delete instead of being silently cleaned up by the FK regardless of
    // RLS the way abuse_endpoint_fingerprints's detach is.
    const otherOrg = await createOrganization({ partnerId: tenant.partnerId, status: 'active' });
    await withSystemDbAccessContext(() =>
      db.insert(alerts).values({
        deviceId: device.id,
        orgId: otherOrg.id,
        severity: 'critical',
        status: 'active',
        title: 'cross-org cascade poison fixture (#5023 wave 05)',
      }),
    );

    // OLD behaviour: the cascade runs entirely inside the CALLER's own-org
    // context — what the route did before this wave. The poisoned alert is
    // invisible under `tenant.orgId`'s policy, so the cascade's
    // `DELETE FROM alerts ...` misses it, and the final `DELETE FROM devices`
    // then hits the NO ACTION foreign key: the whole purge fails and nothing
    // is removed, rather than silently stranding just the one row.
    let caught: unknown;
    try {
      await withDbAccessContext(orgContext(tenant.orgId), () =>
        db.transaction((tx) => purgeRemovedDevice(tx, device.id)),
      );
    } catch (err) {
      caught = err;
    }
    // Pin the SQLSTATE, not just "it threw": a vacuous `rejects.toThrow()`
    // would also pass if the fixture were wrong for an unrelated reason.
    // Drizzle wraps the postgres-js PostgresError in a DrizzleQueryError
    // whose own `.code` is undefined — the SQLSTATE lives on `.cause` (same
    // unwrap hazard `routes/devices/core.ts` documents for this route).
    expect((caught as { cause?: { code?: string } } | undefined)?.cause?.code).toBe('23503');
    expect(await deviceExists(device.id)).toBe(true);
    expect(
      await getTestDb().select({ id: alerts.id }).from(alerts).where(eq(alerts.deviceId, device.id)),
    ).toHaveLength(1);

    // NEW behaviour: escalate exactly as the route does since this wave.
    // System context sees every row regardless of org, so both the child
    // delete and the parent delete succeed.
    await runOutsideDbContext(() =>
      withSystemDbAccessContext(() => db.transaction((tx) => purgeRemovedDevice(tx, device.id))),
    );
    expect(await deviceExists(device.id)).toBe(false);
    expect(
      await getTestDb().select({ id: alerts.id }).from(alerts).where(eq(alerts.deviceId, device.id)),
    ).toHaveLength(0);
  });
});
