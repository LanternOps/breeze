/**
 * Device org move vs. earlier-epoch PAM evidence — PAM ownership epochs
 * W6-pre (#8746, carry-forward from W2 #8514).
 *
 * A device that already left an org carries that org's ACTUATED elevation
 * requests at their original (org_id, device_epoch). Those rows are evidence:
 * `breeze_pam_chain_epoch_guard` refuses (42501) any change to their tenancy.
 * The org-move restamp of `elevation_requests` (both the AFTER UPDATE trigger
 * `breeze_cascade_device_org_id()` and the route's own loop in
 * moveDeviceOrgInTransaction) must therefore leave actuated rows of every
 * epoch where they are.
 *
 * W6 (#8208, spec §7.3/§8, OD4): on a DEVICE MOVE every request stays where
 * it is — the route first expires a live un-actuated one with reason
 * ownership_changed — because a real request carries elevation_audit rows
 * whose (elevation_request_id, org_id) FK cannot follow it outside a merge.
 * Only an org merge (cause org_merge) carries un-actuated requests, with
 * their audit rows, into the device's new epoch.
 *
 * The device-move guard still refuses a move while the device has actuations
 * in its CURRENT org, so the fixture builds the A -> B history by hand
 * (seedMovedDeviceWithHistory) and the test moves B -> C, which is legal
 * today.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { moveDeviceOrgInTransaction } from '../../services/deviceOrgMove/moveDeviceOrgInTransaction';
import { createOrganization, createSite, createUser } from './db-utils';
import { seedMovedDeviceWithHistory } from './ownershipEpochFixture';
import { getTestDb } from './setup';
import { rowsOf } from './orgEvidenceHoldFixture';

const sys = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn));

interface RequestRow { id: string; org_id: string; device_epoch: number; site_id: string | null }

async function requestRow(id: string): Promise<RequestRow | undefined> {
  return rowsOf<RequestRow>(await getTestDb().execute(sql`
    SELECT id, org_id, device_epoch, site_id FROM elevation_requests WHERE id = ${id}::uuid`))[0];
}

async function epoch1ChainMd5(requestId: string): Promise<string> {
  const [row] = rowsOf<{ digest: string }>(await getTestDb().execute(sql`
    SELECT md5(string_agg(r, '|' ORDER BY r)) AS digest FROM (
      SELECT 'req:' || row_to_json(q)::text AS r FROM elevation_requests q WHERE q.id = ${requestId}::uuid
      UNION ALL
      SELECT 'act:' || row_to_json(a)::text FROM pam_actuations a WHERE a.elevation_request_id = ${requestId}::uuid
      UNION ALL
      SELECT 'res:' || row_to_json(x)::text FROM pam_actuation_results x
        WHERE x.actuation_id IN (SELECT id FROM pam_actuations WHERE elevation_request_id = ${requestId}::uuid)
    ) chain`));
  return row!.digest;
}

/** A -> B history (closed epoch-1 chain in A), plus an un-actuated request (with its `requested` audit row) in B's epoch 2. */
async function seed() {
  const seeded = await seedMovedDeviceWithHistory({ path: ['A', 'B'] });
  const b = seeded.orgs.B!;
  const pendingId = randomUUID();
  await sys(() => db.execute(sql`
    INSERT INTO elevation_requests (
      id, org_id, site_id, partner_id, device_id, flow_type, subject_username, reason,
      target_executable_path, target_executable_hash, status
    ) VALUES (
      ${pendingId}::uuid, ${b.id}::uuid, ${b.siteId}::uuid, ${seeded.partnerId}::uuid, ${seeded.deviceId}::uuid,
      'uac_intercept', 'fixture-user', 'pending in epoch 2', 'C:\\fixture.exe', ${'b'.repeat(64)}, 'pending'
    )`));
  await sys(() => db.execute(sql`
    INSERT INTO elevation_audit (org_id, elevation_request_id, event_type, actor, details, occurred_at)
    VALUES (${b.id}::uuid, ${pendingId}::uuid, 'requested', 'end_user', '{}'::jsonb, now())`));
  const c = await createOrganization({ partnerId: seeded.partnerId });
  const cSite = await createSite({ orgId: c.id });
  const user = await createUser({ partnerId: seeded.partnerId, orgId: null, email: `move-${pendingId}@epoch.test` });
  return { ...seeded, pendingId, c: { id: c.id, siteId: cSite!.id }, userId: user.id };
}

describe('org move leaves elevation requests in place; merge carries un-actuated ones (#8746, #8208)', () => {
  it('a direct devices.org_id write (trigger path) keeps epoch-1 evidence and leaves the un-actuated request in its epoch', async () => {
    const s = await seed();
    const md5Before = await epoch1ChainMd5(s.epoch1.requestId);

    await sys(() => db.execute(sql`
      UPDATE devices SET org_id = ${s.c.id}::uuid, site_id = ${s.c.siteId}::uuid WHERE id = ${s.deviceId}::uuid`));

    expect(await requestRow(s.epoch1.requestId)).toMatchObject({ org_id: s.orgs.A!.id, device_epoch: 1 });
    expect(await epoch1ChainMd5(s.epoch1.requestId)).toBe(md5Before);
    expect(await requestRow(s.pendingId)).toMatchObject({ org_id: s.orgs.B!.id, device_epoch: 2, site_id: s.orgs.B!.siteId });
  }, 120_000);

  it('the move route transaction keeps epoch-1 evidence, expires the pending request (OD4) and leaves it in the source epoch', async () => {
    const s = await seed();
    const md5Before = await epoch1ChainMd5(s.epoch1.requestId);

    await sys(() => db.transaction((tx) => moveDeviceOrgInTransaction(tx, {
      deviceId: s.deviceId,
      sourceOrgId: s.orgs.B!.id,
      targetOrgId: s.c.id,
      targetSiteId: s.c.siteId,
      targetOrgName: 'target',
      deviceLinkGroupId: null,
      acceptCurrencyMismatch: false,
      actor: { userId: s.userId, allowedSiteIds: undefined },
      stepUp: null,
      via: 'generic_move',
    })));

    expect(await requestRow(s.epoch1.requestId)).toMatchObject({ org_id: s.orgs.A!.id, device_epoch: 1 });
    expect(await epoch1ChainMd5(s.epoch1.requestId)).toBe(md5Before);
    expect(await requestRow(s.pendingId)).toMatchObject({ org_id: s.orgs.B!.id, device_epoch: 2, site_id: s.orgs.B!.siteId });
    expect(rowsOf(await getTestDb().execute(sql`
      SELECT r.status::text AS status, (r.expired_at IS NOT NULL) AS stamped,
             (SELECT count(*)::int FROM elevation_audit e
               WHERE e.elevation_request_id = r.id AND e.org_id = r.org_id AND e.event_type = 'expired'
                 AND e.actor = 'system' AND e.details ->> 'cause' = 'ownership_changed'
                 AND e.details ->> 'prior_status' = 'pending') AS expired_audits,
             (SELECT count(*)::int FROM elevation_audit e WHERE e.elevation_request_id = r.id) AS audits
        FROM elevation_requests r WHERE r.id = ${s.pendingId}::uuid`)))
      .toEqual([{ status: 'expired', stamped: true, expired_audits: 1, audits: 2 }]);
  }, 120_000);

  it('cause org_merge (merge engine) carries the un-actuated request AND its audit rows into the new epoch', async () => {
    const s = await seed();
    const md5Before = await epoch1ChainMd5(s.epoch1.requestId);

    await sys(() => db.transaction(async (tx) => {
      await tx.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
      await tx.execute(sql`SELECT set_config('breeze.ownership_change_cause', 'org_merge', true)`);
      await tx.execute(sql`
        UPDATE devices SET org_id = ${s.c.id}::uuid, site_id = ${s.c.siteId}::uuid WHERE id = ${s.deviceId}::uuid`);
    }));

    expect(await requestRow(s.epoch1.requestId)).toMatchObject({ org_id: s.orgs.A!.id, device_epoch: 1 });
    expect(await epoch1ChainMd5(s.epoch1.requestId)).toBe(md5Before);
    expect(await requestRow(s.pendingId)).toMatchObject({ org_id: s.c.id, device_epoch: 3 });
    expect(rowsOf(await getTestDb().execute(sql`
      SELECT org_id::text AS org_id FROM elevation_audit WHERE elevation_request_id = ${s.pendingId}::uuid`)))
      .toEqual([{ org_id: s.c.id }]);
  }, 120_000);

  it('A -> B -> A: returning to the epoch-1 org still leaves epoch-1 evidence at epoch 1', async () => {
    const s = await seed();
    const md5Before = await epoch1ChainMd5(s.epoch1.requestId);
    const aSite = s.orgs.A!.siteId;

    await sys(() => db.execute(sql`
      UPDATE devices SET org_id = ${s.orgs.A!.id}::uuid, site_id = ${aSite}::uuid WHERE id = ${s.deviceId}::uuid`));

    expect(await requestRow(s.epoch1.requestId)).toMatchObject({ org_id: s.orgs.A!.id, device_epoch: 1 });
    expect(await epoch1ChainMd5(s.epoch1.requestId)).toBe(md5Before);
    expect(await requestRow(s.pendingId)).toMatchObject({ org_id: s.orgs.B!.id, device_epoch: 2 });
  }, 120_000);
});
