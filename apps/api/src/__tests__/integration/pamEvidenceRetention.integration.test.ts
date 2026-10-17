/**
 * PAM evidence retention (PAM ownership epochs W5, #8207, spec §7.2) on real
 * Postgres. The job deletes expired PAM request chains of HELD SHELLS only,
 * through breeze_audit_admin + breeze.allow_audit_retention, so that
 * `releaseEmptyEvidenceHolds` can then release the hold.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { getTestDb } from './setup';
import { seedMovedDeviceWithHistory, type SeededMovedDevice } from './ownershipEpochFixture';
import {
  chainMd5,
  countChainRows,
  holdRow,
  insertHoldRaw,
  markMergedShell,
  rowsOf,
} from './orgEvidenceHoldFixture';
import { releaseEmptyEvidenceHolds } from '../../services/orgEvidenceHold';
import { prunePamEvidence } from '../../jobs/pamEvidenceRetention';

const TTL_DAYS = 400;

/** Held shell L (owns the seeded epoch-1 chain) merged into survivor S. */
async function seedHeldShell() {
  const seeded = await seedMovedDeviceWithHistory({ path: ['L', 'S'] });
  const loser = seeded.orgs.L!.id;
  const survivor = seeded.orgs.S!.id;
  const mergeEventId = await markMergedShell({ partnerId: seeded.partnerId, loserOrgId: loser, survivorOrgId: survivor });
  await insertHoldRaw({ partnerId: seeded.partnerId, loserOrgId: loser, survivorOrgId: survivor, mergeEventId });
  return { ...seeded, loser, survivor };
}

/** Same chain shape as the fixture's, for a second request on the same device/epoch. */
async function insertExtraChain(seeded: SeededMovedDevice, orgKey: string): Promise<string> {
  const org = seeded.orgs[orgKey]!;
  const requestId = randomUUID();
  const actuationId = randomUUID();
  const hash = 'b'.repeat(64);
  const exe = 'C:\\Program Files\\Fixture\\second.exe';
  await getTestDb().transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`);
    await tx.execute(sql`
      INSERT INTO elevation_requests (id, org_id, site_id, partner_id, device_id, device_epoch, flow_type,
        subject_username, reason, target_executable_path, target_executable_hash, status, approved_at, expired_at)
      VALUES (${requestId}::uuid, ${org.id}::uuid, ${org.siteId}::uuid, ${seeded.partnerId}::uuid, ${seeded.deviceId}::uuid, 1,
        'uac_intercept', 'fixture-user', 'second chain', ${exe}, ${hash}, 'expired', now(), now())`);
    await tx.execute(sql`
      INSERT INTO pam_actuations (id, org_id, device_id, device_epoch, elevation_request_id, request_revision, generation,
        desired_state, observed_state, target_executable_path, target_executable_hash, subject_username)
      VALUES (${actuationId}::uuid, ${org.id}::uuid, ${seeded.deviceId}::uuid, 1, ${requestId}::uuid, 1, 1,
        'cleanup', 'cleaned', ${exe}, ${hash}, 'fixture-user')`);
    await tx.execute(sql`
      INSERT INTO pam_actuation_results (id, observation_id, org_id, device_id, device_epoch, actuation_id, generation,
        result_kind, evidence, observed_at)
      VALUES (${randomUUID()}::uuid, ${randomUUID()}::uuid, ${org.id}::uuid, ${seeded.deviceId}::uuid, 1, ${actuationId}::uuid, 1,
        'cleaned', '{}'::jsonb, now())`);
  });
  return requestId;
}

/** An audit row on a request (the fixture seeds none). */
async function insertAudit(orgId: string, requestId: string): Promise<void> {
  await getTestDb().transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`);
    await tx.execute(sql`
      INSERT INTO elevation_audit (org_id, elevation_request_id, event_type, actor, details, occurred_at)
      VALUES (${orgId}::uuid, ${requestId}::uuid, 'requested', 'system', '{}'::jsonb, now())`);
  });
}

/** Backdate every row of one request chain to `daysAgo`. */
async function ageChain(orgId: string, requestId: string, daysAgo: number): Promise<void> {
  await getTestDb().transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`);
    const ts = sql`now() - make_interval(days => ${daysAgo})`;
    await tx.execute(sql`UPDATE elevation_requests SET created_at = ${ts}, updated_at = ${ts}
      WHERE id = ${requestId}::uuid AND org_id = ${orgId}::uuid`);
    await tx.execute(sql`UPDATE elevation_audit SET created_at = ${ts}, occurred_at = ${ts}
      WHERE elevation_request_id = ${requestId}::uuid AND org_id = ${orgId}::uuid`);
    await tx.execute(sql`UPDATE pam_actuations SET created_at = ${ts}, updated_at = ${ts}
      WHERE elevation_request_id = ${requestId}::uuid AND org_id = ${orgId}::uuid`);
    await tx.execute(sql`UPDATE pam_actuation_results SET received_at = ${ts}, observed_at = ${ts}
      WHERE org_id = ${orgId}::uuid AND actuation_id IN (
        SELECT id FROM pam_actuations WHERE elevation_request_id = ${requestId}::uuid AND org_id = ${orgId}::uuid)`);
  });
}

async function countTable(table: string, orgId: string): Promise<number> {
  const [row] = rowsOf<{ n: number }>(await getTestDb().execute(
    sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE org_id = ${orgId}::uuid`));
  return Number(row?.n ?? 0);
}

async function release() {
  return withSystemDbAccessContext(() => releaseEmptyEvidenceHolds());
}

describe('PAM evidence retention (real Postgres)', () => {
  it('(a) deletes a held shell chain older than the TTL in all four tables, then the hold releases', async () => {
    const m = await seedHeldShell();
    await insertAudit(m.loser, m.epoch1.requestId);
    await ageChain(m.loser, m.epoch1.requestId, TTL_DAYS + 30);
    expect(await countChainRows(m.loser)).toBe(4);

    // The job must be what empties it: the hold cannot release first.
    expect(await release()).toEqual([]);

    const stats = await prunePamEvidence();
    expect(stats.errors).toBe(0);
    expect(stats.chainsDeleted).toBeGreaterThanOrEqual(1);

    for (const t of ['pam_actuation_results', 'pam_actuations', 'elevation_audit', 'elevation_requests']) {
      expect(await countTable(t, m.loser), t).toBe(0);
    }
    const released = await release();
    expect(released.map((h) => h.loserOrgId)).toContain(m.loser);
    expect(await holdRow(m.loser)).toBeUndefined();
  }, 60_000);

  it('(b) deletes only the expired chain of a shell; a fresh chain keeps the hold', async () => {
    const m = await seedHeldShell();
    const freshRequestId = await insertExtraChain(m, 'L');
    await insertAudit(m.loser, m.epoch1.requestId);
    await insertAudit(m.loser, freshRequestId);
    await ageChain(m.loser, m.epoch1.requestId, TTL_DAYS + 30);
    await ageChain(m.loser, freshRequestId, 10);

    await prunePamEvidence();

    const remainingRequests = rowsOf<{ id: string }>(await getTestDb().execute(
      sql`SELECT id FROM elevation_requests WHERE org_id = ${m.loser}::uuid`));
    expect(remainingRequests.map((r) => r.id)).toEqual([freshRequestId]);
    expect(await countTable('pam_actuations', m.loser)).toBe(1);
    expect(await countTable('pam_actuation_results', m.loser)).toBe(1);
    expect(await countTable('elevation_audit', m.loser)).toBe(1);
    expect((await release()).map((h) => h.loserOrgId)).not.toContain(m.loser);
    expect(await holdRow(m.loser)).toBeDefined();
  }, 60_000);

  it('(b2) a chain with one recent child row is not half-deleted', async () => {
    const m = await seedHeldShell();
    await ageChain(m.loser, m.epoch1.requestId, TTL_DAYS + 30);
    // A late audit row makes the chain's newest activity recent.
    await insertAudit(m.loser, m.epoch1.requestId);
    const before = await chainMd5(m.loser);

    await prunePamEvidence();

    expect(await chainMd5(m.loser)).toBe(before);
    expect(await countChainRows(m.loser)).toBe(4);
  }, 60_000);

  it('(c) never touches an old chain of an org that is not a held shell', async () => {
    const live = await seedMovedDeviceWithHistory({ path: ['P', 'Q'] }); // P owns an old chain, no hold
    const pOrg = live.orgs.P!.id;
    await insertAudit(pOrg, live.epoch1.requestId);
    await ageChain(pOrg, live.epoch1.requestId, TTL_DAYS + 365);
    const before = await chainMd5(pOrg);
    const rowsBefore = await countChainRows(pOrg);
    expect(rowsBefore).toBe(4);

    // Run alongside a real held shell so the job demonstrably does work.
    const held = await seedHeldShell();
    await ageChain(held.loser, held.epoch1.requestId, TTL_DAYS + 30);
    await prunePamEvidence();

    expect(await countChainRows(held.loser)).toBe(0);
    expect(await countChainRows(pOrg)).toBe(rowsBefore);
    expect(await chainMd5(pOrg)).toBe(before);
  }, 60_000);

  it('(d) breeze.allow_audit_retention is load-bearing for pam_actuation_results', async () => {
    const m = await seedHeldShell();
    await ageChain(m.loser, m.epoch1.requestId, TTL_DAYS + 30);

    // Role switched, GUC NOT armed: the append-only trigger refuses.
    await expect(withSystemDbAccessContext(async () => {
      await db.execute(sql`SET LOCAL ROLE breeze_audit_admin`);
      await db.execute(sql`DELETE FROM pam_actuation_results WHERE org_id = ${m.loser}::uuid`);
    })).rejects.toThrow();
    expect(await countTable('pam_actuation_results', m.loser)).toBe(1);

    // The job arms it and succeeds.
    await prunePamEvidence();
    expect(await countTable('pam_actuation_results', m.loser)).toBe(0);
  }, 60_000);

  it('cascades the actuation intent_outbox rows (FK referential action, not a grant)', async () => {
    const m = await seedHeldShell();
    await getTestDb().transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx.execute(sql`
        INSERT INTO intent_outbox (pam_actuation_id, event_type, payload)
        VALUES (${m.epoch1.actuationId}::uuid, 'pam.desired_state_changed', '{}'::jsonb)`);
    });
    await ageChain(m.loser, m.epoch1.requestId, TTL_DAYS + 30);

    const stats = await prunePamEvidence();
    expect(stats.errors).toBe(0);
    const [row] = rowsOf<{ n: number }>(await getTestDb().execute(
      sql`SELECT count(*)::int AS n FROM intent_outbox WHERE pam_actuation_id = ${m.epoch1.actuationId}::uuid`));
    expect(Number(row?.n)).toBe(0);
  }, 60_000);
});
