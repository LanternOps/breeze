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
 * epoch where they are, while an UN-actuated request still follows the device
 * into its new epoch (the guard re-anchors it).
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

/** A -> B history (closed epoch-1 chain in A), plus an un-actuated request in B's epoch 2. */
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
  const c = await createOrganization({ partnerId: seeded.partnerId });
  const cSite = await createSite({ orgId: c.id });
  const user = await createUser({ partnerId: seeded.partnerId, orgId: null, email: `move-${pendingId}@epoch.test` });
  return { ...seeded, pendingId, c: { id: c.id, siteId: cSite!.id }, userId: user.id };
}

describe('org move leaves earlier-epoch actuated elevation requests in place (#8746)', () => {
  it('a direct devices.org_id write (trigger path) keeps epoch-1 evidence and moves the un-actuated request', async () => {
    const s = await seed();
    const md5Before = await epoch1ChainMd5(s.epoch1.requestId);

    await sys(() => db.execute(sql`
      UPDATE devices SET org_id = ${s.c.id}::uuid, site_id = ${s.c.siteId}::uuid WHERE id = ${s.deviceId}::uuid`));

    expect(await requestRow(s.epoch1.requestId)).toMatchObject({ org_id: s.orgs.A!.id, device_epoch: 1 });
    expect(await epoch1ChainMd5(s.epoch1.requestId)).toBe(md5Before);
    expect(await requestRow(s.pendingId)).toMatchObject({ org_id: s.c.id, device_epoch: 3 });
  }, 120_000);

  it('the move route transaction keeps epoch-1 evidence and moves the un-actuated request', async () => {
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
    expect(await requestRow(s.pendingId)).toMatchObject({ org_id: s.c.id, device_epoch: 3, site_id: s.c.siteId });
  }, 120_000);

  it('A -> B -> A: returning to the epoch-1 org still leaves epoch-1 evidence at epoch 1', async () => {
    const s = await seed();
    const md5Before = await epoch1ChainMd5(s.epoch1.requestId);
    const aSite = s.orgs.A!.siteId;

    await sys(() => db.execute(sql`
      UPDATE devices SET org_id = ${s.orgs.A!.id}::uuid, site_id = ${aSite}::uuid WHERE id = ${s.deviceId}::uuid`));

    expect(await requestRow(s.epoch1.requestId)).toMatchObject({ org_id: s.orgs.A!.id, device_epoch: 1 });
    expect(await epoch1ChainMd5(s.epoch1.requestId)).toBe(md5Before);
    expect(await requestRow(s.pendingId)).toMatchObject({ org_id: s.orgs.A!.id, device_epoch: 3 });
  }, 120_000);
});
