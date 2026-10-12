/**
 * Org merge evidence holds — PAM ownership epochs W5 (#8207), spec §7.1–7.2.
 *
 * A merge whose loser still owns PAM-chain rows after the Phase-B walk keeps
 * the loser as a held shell instead of erasing it. These tests build the
 * post-Phase-B state by hand (`markMergedShell`; `blocks-merge` still refuses
 * such merges until W6) and then drive the real Phase-B hold writer, the
 * job's Phase C, the offboarding sweeper and the erasure cascade.
 *
 * Proves:
 *   5.1 the hold is written; Phase C skips the erasure enqueue and audits it;
 *       the sweeper never erases the shell; a direct erasure is refused; the
 *       shell keeps deleted_at; the chain is byte-identical throughout.
 *   5.2 transitive holds (A -> B -> C keeps A's evidence); the depth cap;
 *       survivor erasure erases its held shells first; retention expiry
 *       releases the hold and hands the shell to erasure; the survivor FK is
 *       RESTRICT, not CASCADE.
 */
import './setup';
import { describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { getTestDb } from './setup';
import { createOrganization, createPartner, createUser } from './db-utils';
import { seedMovedDeviceWithHistory } from './ownershipEpochFixture';
import {
  chainMd5,
  countChainRows,
  expireChainByRetention,
  holdRow,
  insertHoldRaw,
  markMergedShell,
  orgState,
  rowsOf,
  seedHeldLineage,
} from './orgEvidenceHoldFixture';
import { writeEvidenceHold } from '../../services/orgEvidenceHold';
import * as orgMergeModule from '../../services/orgMerge';
import { runMergePhaseC } from '../../jobs/orgMerge';
import { sweepOffboardingTenants } from '../../services/tenantOffboarding';
import { getTenantErasureQueue } from '../../jobs/tenantErasure';
import { cascadeDeleteOrg, cascadeDeletePartner, TenantCascadeRefusalError } from '../../services/tenantCascade';

async function eventually(check: () => Promise<void>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await check();
      return;
    } catch (err) {
      if (Date.now() >= deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

async function auditsFor(action: string, resourceId: string) {
  return rowsOf<{ org_id: string | null; details: Record<string, unknown> }>(await getTestDb().execute(sql`
    SELECT org_id, details FROM audit_logs WHERE action = ${action} AND resource_id = ${resourceId}::uuid`));
}

async function erasureJobFor(orgId: string) {
  return getTenantErasureQueue().getJob(`tenant-erasure-${orgId}`);
}

async function writeHold(input: { partnerId: string; loserOrgId: string; survivorOrgId: string; mergeEventId: string }) {
  return withSystemDbAccessContext(() => writeEvidenceHold(input));
}

/** L (loser) holds a closed epoch-1 PAM chain; the device has since moved to S (survivor). */
async function seedHeldMerge() {
  const seeded = await seedMovedDeviceWithHistory({ path: ['L', 'S'] });
  const loser = seeded.orgs.L!.id;
  const survivor = seeded.orgs.S!.id;
  const mergeEventId = await markMergedShell({ partnerId: seeded.partnerId, loserOrgId: loser, survivorOrgId: survivor });
  return { ...seeded, loser, survivor, mergeEventId };
}

describe('5.1 hold written in Phase B; Phase C and the sweeper skip held shells', () => {
  it('writes the hold, defers erasure with an audit, and leaves the chain byte-identical', async () => {
    const m = await seedHeldMerge();
    const actor = await createUser({ partnerId: m.partnerId, orgId: m.survivor, email: `merge-${m.loser}@hold.test` });
    const md5Before = await chainMd5(m.loser);
    expect(await countChainRows(m.loser)).toBeGreaterThan(0);

    const reason = await writeHold({
      partnerId: m.partnerId, loserOrgId: m.loser, survivorOrgId: m.survivor, mergeEventId: m.mergeEventId,
    });
    expect(reason).toBe('pam_evidence');
    expect(await holdRow(m.loser)).toMatchObject({
      loser_org_id: m.loser,
      partner_id: m.partnerId,
      survivor_org_id: m.survivor,
      merge_event_id: m.mergeEventId,
      reason: 'pam_evidence',
    });

    // Phase C — the job's dispose step.
    await runMergePhaseC(
      { loserOrgId: m.loser, survivorOrgId: m.survivor, partnerId: m.partnerId, performedBy: actor.id },
      { tables: {}, warnings: [], summary: {}, mergeEventId: m.mergeEventId },
    );
    expect(await erasureJobFor(m.loser), 'Phase C enqueued erasure of a held shell').toBeFalsy();
    const deferred = await auditsFor('tenant.erasure.deferred_evidence_hold', m.loser);
    expect(deferred).toHaveLength(1);
    expect(deferred[0]!.org_id).toBeNull();
    expect(deferred[0]!.details).toMatchObject({ survivorOrgId: m.survivor, stage: 'merge_phase_c' });
    expect(await auditsFor('org.merge.erasure_enqueued', m.loser)).toHaveLength(0);

    // The sweeper's merge-erasure retry must not pick the shell up either.
    const sweep = await sweepOffboardingTenants();
    expect(sweep.failures).toBe(0);
    expect(await erasureJobFor(m.loser), 'the sweeper enqueued erasure of a held shell').toBeFalsy();

    // A direct erasure (any enqueue path ends here) is refused before any row goes.
    const refused = await cascadeDeleteOrg(m.loser, actor.id).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(TenantCascadeRefusalError);
    expect((refused as TenantCascadeRefusalError).code).toBe('EVIDENCE_HOLD_ACTIVE');
    await eventually(async () => {
      expect((await auditsFor('tenant.erasure.deferred_evidence_hold', m.loser)).length).toBe(2);
    });

    expect(await orgState(m.loser)).toEqual({ status: 'merging', deleted: true });
    expect(await chainMd5(m.loser)).toBe(md5Before);
    expect(await holdRow(m.loser)).toBeDefined();
  }, 120_000);

  it('writes no hold when the loser owns no PAM chain and is no survivor of a held shell', async () => {
    const m = await seedHeldMerge();
    const other = await createOrganization({ partnerId: m.partnerId });
    const eventId = await markMergedShell({ partnerId: m.partnerId, loserOrgId: other.id, survivorOrgId: m.survivor });
    const reason = await writeHold({
      partnerId: m.partnerId, loserOrgId: other.id, survivorOrgId: m.survivor, mergeEventId: eventId,
    });
    expect(reason).toBeNull();
    expect(await holdRow(other.id)).toBeUndefined();
  });
});

describe('5.2 transitive holds, depth cap, and release', () => {
  it('transitive hold: A -> B (A held), then B -> C holds B and nothing erases A', async () => {
    const m = await seedHeldMerge(); // A = m.loser, B = m.survivor
    const actor = await createUser({ partnerId: m.partnerId, orgId: m.survivor, email: `t-${m.loser}@hold.test` });
    await writeHold({ partnerId: m.partnerId, loserOrgId: m.loser, survivorOrgId: m.survivor, mergeEventId: m.mergeEventId });
    const md5A = await chainMd5(m.loser);

    const c = await createOrganization({ partnerId: m.partnerId });
    const eventBC = await markMergedShell({ partnerId: m.partnerId, loserOrgId: m.survivor, survivorOrgId: c.id });
    const reason = await writeHold({ partnerId: m.partnerId, loserOrgId: m.survivor, survivorOrgId: c.id, mergeEventId: eventBC });
    expect(reason).toBe('transitive');
    expect(await holdRow(m.survivor)).toMatchObject({ survivor_org_id: c.id, reason: 'transitive' });

    await sweepOffboardingTenants();
    expect(await erasureJobFor(m.loser)).toBeFalsy();
    expect(await erasureJobFor(m.survivor)).toBeFalsy();
    await expect(cascadeDeleteOrg(m.survivor, actor.id)).rejects.toMatchObject({ code: 'EVIDENCE_HOLD_ACTIVE' });
    await expect(cascadeDeleteOrg(m.loser, actor.id)).rejects.toMatchObject({ code: 'EVIDENCE_HOLD_ACTIVE' });

    expect(await chainMd5(m.loser)).toBe(md5A);
    expect(await orgState(m.loser)).toEqual({ status: 'merging', deleted: true });
    expect(await orgState(m.survivor)).toEqual({ status: 'merging', deleted: true });
  }, 120_000);

  it('refuses a merge that would push a held lineage past depth 5, with reason lineage_depth', async () => {
    const partner = await createPartner();
    const m = { partnerId: partner.id };
    // o0 -> o1 -> ... -> o5: five held hops end at a live org.
    const lineage = await seedHeldLineage(m.partnerId, 5);
    const deepest = lineage[lineage.length - 1]!;
    const target = await createOrganization({ partnerId: m.partnerId });

    const caught = await withSystemDbAccessContext(() =>
      orgMergeModule.assertMergeLineageDepth(deepest, target.id),
    ).catch((err: unknown) => err);
    expect(caught).toBeInstanceOf(orgMergeModule.OrgMergeBlockedError);
    expect((caught as orgMergeModule.OrgMergeBlockedError).reason).toBe('lineage_depth');

    // One hop shorter is fine.
    await expect(
      withSystemDbAccessContext(() => orgMergeModule.assertMergeLineageDepth(lineage[4]!, target.id)),
    ).resolves.toBeUndefined();

    // The engine refuses pre-fence: the loser is never fenced.
    const actor = await createUser({ partnerId: m.partnerId, orgId: target.id, email: `d-${deepest}@hold.test` });
    const fence = vi.spyOn(orgMergeModule, 'fenceLoser');
    try {
      await expect(orgMergeModule.executeOrgMerge({
        loserOrgId: deepest, survivorOrgId: target.id, partnerId: m.partnerId, performedBy: actor.id,
      })).rejects.toMatchObject({ code: 'ORG_MERGE_BLOCKED', reason: 'lineage_depth' });
      expect(fence).not.toHaveBeenCalled();
    } finally {
      fence.mockRestore();
    }
    expect(await orgState(deepest)).toEqual({ status: 'active', deleted: false });
  }, 120_000);

  it('survivor erasure erases its held shells first, then itself', async () => {
    const m = await seedHeldMerge();
    const actor = await createUser({ partnerId: m.partnerId, orgId: null, email: `s-${m.loser}@hold.test` });
    await writeHold({ partnerId: m.partnerId, loserOrgId: m.loser, survivorOrgId: m.survivor, mergeEventId: m.mergeEventId });

    await cascadeDeleteOrg(m.survivor, actor.id);

    expect(await orgState(m.loser)).toBeUndefined();
    expect(await orgState(m.survivor)).toBeUndefined();
    expect(await countChainRows(m.loser)).toBe(0);
    expect(await holdRow(m.loser)).toBeUndefined();
    await eventually(async () => {
      const released = await auditsFor('tenant.erasure.evidence_hold_released', m.loser);
      expect(released).toHaveLength(1);
      expect(released[0]!.details).toMatchObject({ trigger: 'survivor_erasure', survivorOrgId: m.survivor });
    });
  }, 120_000);

  it('survivor erasure walks a transitive lineage: erasing C erases B and A', async () => {
    const m = await seedHeldMerge();
    const actor = await createUser({ partnerId: m.partnerId, orgId: null, email: `tc-${m.loser}@hold.test` });
    await writeHold({ partnerId: m.partnerId, loserOrgId: m.loser, survivorOrgId: m.survivor, mergeEventId: m.mergeEventId });
    const c = await createOrganization({ partnerId: m.partnerId });
    const eventBC = await markMergedShell({ partnerId: m.partnerId, loserOrgId: m.survivor, survivorOrgId: c.id });
    await writeHold({ partnerId: m.partnerId, loserOrgId: m.survivor, survivorOrgId: c.id, mergeEventId: eventBC });

    await cascadeDeleteOrg(c.id, actor.id);
    for (const id of [m.loser, m.survivor, c.id]) expect(await orgState(id)).toBeUndefined();
    expect(rowsOf(await getTestDb().execute(sql`
      SELECT 1 FROM org_evidence_holds WHERE partner_id = ${m.partnerId}::uuid`))).toHaveLength(0);
  }, 120_000);

  it('retention expiry empties the chain, the sweeper releases the hold and hands the shell to erasure', async () => {
    const m = await seedHeldMerge();
    await writeHold({ partnerId: m.partnerId, loserOrgId: m.loser, survivorOrgId: m.survivor, mergeEventId: m.mergeEventId });

    // Still held while the chain has rows.
    await sweepOffboardingTenants();
    expect(await holdRow(m.loser)).toBeDefined();
    expect(await erasureJobFor(m.loser)).toBeFalsy();

    await expireChainByRetention(m.loser);
    const sweep = await sweepOffboardingTenants();
    expect(sweep.failures).toBe(0);
    expect(sweep.evidenceHoldsReleased).toBe(1);
    expect(await holdRow(m.loser)).toBeUndefined();
    const job = await erasureJobFor(m.loser);
    expect(job, 'the released shell was never handed to tenant erasure').toBeTruthy();
    await eventually(async () => {
      const released = await auditsFor('tenant.erasure.evidence_hold_released', m.loser);
      expect(released).toHaveLength(1);
      expect(released[0]!.details).toMatchObject({ trigger: 'chain_empty' });
    });
  }, 120_000);

  it('a shell that is the survivor of a held shell is not released while that hold stands', async () => {
    const m = await seedHeldMerge();
    await writeHold({ partnerId: m.partnerId, loserOrgId: m.loser, survivorOrgId: m.survivor, mergeEventId: m.mergeEventId });
    const c = await createOrganization({ partnerId: m.partnerId });
    const eventBC = await markMergedShell({ partnerId: m.partnerId, loserOrgId: m.survivor, survivorOrgId: c.id });
    await writeHold({ partnerId: m.partnerId, loserOrgId: m.survivor, survivorOrgId: c.id, mergeEventId: eventBC });

    // B owns no chain rows of its own, but A's hold names it as survivor.
    expect(await countChainRows(m.survivor)).toBe(0);
    const sweep = await sweepOffboardingTenants();
    expect(sweep.evidenceHoldsReleased).toBe(0);
    expect(await holdRow(m.survivor)).toBeDefined();
    expect(await erasureJobFor(m.survivor)).toBeFalsy();
  }, 120_000);

  it('the survivor FK is RESTRICT: deleting a survivor org row under a live hold fails', async () => {
    const m = await seedHeldMerge();
    const loser = await createOrganization({ partnerId: m.partnerId });
    const survivor = await createOrganization({ partnerId: m.partnerId });
    const eventId = await markMergedShell({ partnerId: m.partnerId, loserOrgId: loser.id, survivorOrgId: survivor.id });
    await insertHoldRaw({ partnerId: m.partnerId, loserOrgId: loser.id, survivorOrgId: survivor.id, mergeEventId: eventId });

    const err = await getTestDb().execute(sql`DELETE FROM organizations WHERE id = ${survivor.id}::uuid`)
      .then(() => undefined, (e: unknown) => e as { cause?: { code?: string; message?: string } });
    expect(err, 'survivor org deleted while a hold names it').toBeDefined();
    expect(err!.cause?.code).toBe('23503');
    expect(await holdRow(loser.id)).toBeDefined();
  });

  it('breeze_app can neither write nor delete a hold outside system scope', async () => {
    const m = await seedHeldMerge();
    await writeHold({ partnerId: m.partnerId, loserOrgId: m.loser, survivorOrgId: m.survivor, mergeEventId: m.mergeEventId });
    const { withDbAccessContext } = await import('../../db');
    const partnerCtx = {
      scope: 'partner' as const, orgId: null, accessibleOrgIds: [m.survivor], accessiblePartnerIds: [m.partnerId], userId: null,
    };
    const deleted = await withDbAccessContext(partnerCtx, async () => rowsOf(await db.execute(sql`
      DELETE FROM org_evidence_holds WHERE loser_org_id = ${m.loser}::uuid RETURNING loser_org_id`)));
    expect(deleted).toHaveLength(0);
    expect(await holdRow(m.loser)).toBeDefined();

    const forged = await withDbAccessContext(partnerCtx, () => db.execute(sql`
      INSERT INTO org_evidence_holds (loser_org_id, partner_id, survivor_org_id, merge_event_id, reason)
      VALUES (gen_random_uuid(), ${m.partnerId}::uuid, ${m.survivor}::uuid, ${m.mergeEventId}::uuid, 'pam_evidence')`))
      .then(() => undefined, (e: unknown) => e as { cause?: { code?: string; message?: string } });
    expect(forged, 'partner-scope insert into org_evidence_holds succeeded').toBeDefined();
    expect(forged!.cause?.code).toBe('42501');
    expect(forged!.cause?.message).toMatch(/row-level security policy/);
  });
});


// ---------------------------------------------------------------------------
// Review follow-ups: per-table release semantics, partial failure, partner
// purge, and the sweeper's stamp-recovery path.
// ---------------------------------------------------------------------------

async function seedLegalHold(orgId: string, siteId: string): Promise<void> {
  const db_ = getTestDb();
  const [device] = rowsOf<{ id: string }>(await db_.execute(sql`
    INSERT INTO devices (org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version)
    VALUES (${orgId}::uuid, ${siteId}::uuid, ${`agent-hold-${orgId}`}, 'held-shell-backup', 'windows', '11', 'amd64', '1.0.0')
    RETURNING id`));
  const [config] = rowsOf<{ id: string }>(await db_.execute(sql`
    INSERT INTO backup_configs (org_id, name, type, provider, provider_config)
    VALUES (${orgId}::uuid, 'held shell legal hold', 'file', 'local', '{}') RETURNING id`));
  const [job] = rowsOf<{ id: string }>(await db_.execute(sql`
    INSERT INTO backup_jobs (org_id, config_id, device_id)
    VALUES (${orgId}::uuid, ${config!.id}::uuid, ${device!.id}::uuid) RETURNING id`));
  await db_.execute(sql`
    INSERT INTO backup_snapshots (org_id, job_id, device_id, snapshot_id, legal_hold)
    VALUES (${orgId}::uuid, ${job!.id}::uuid, ${device!.id}::uuid, gen_random_uuid()::text, true)`);
}

describe('review follow-ups', () => {
  it('any remaining chain table keeps the hold; it releases only when the last one is empty', async () => {
    const m = await seedHeldMerge();
    await getTestDb().execute(sql`
      INSERT INTO elevation_audit (org_id, elevation_request_id, event_type, actor, details, occurred_at)
      VALUES (${m.loser}::uuid, ${m.epoch1.requestId}::uuid, 'requested', 'system', '{}'::jsonb, now())`);
    await writeHold({ partnerId: m.partnerId, loserOrgId: m.loser, survivorOrgId: m.survivor, mergeEventId: m.mergeEventId });

    // Children before parents (FK order). After each step at least one chain
    // table still has rows, so the hold must stand.
    const steps = [
      sql`DELETE FROM pam_actuation_results WHERE org_id = ${m.loser}::uuid`,
      sql`DELETE FROM pam_actuations WHERE org_id = ${m.loser}::uuid`,
      sql`DELETE FROM elevation_audit WHERE org_id = ${m.loser}::uuid`,
    ];
    for (const step of steps) {
      await getTestDb().transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL session_replication_role = replica`);
        await tx.execute(step);
      });
      const sweep = await sweepOffboardingTenants();
      expect(sweep.evidenceHoldsReleased).toBe(0);
      expect(await holdRow(m.loser)).toBeDefined();
      expect(await erasureJobFor(m.loser)).toBeFalsy();
    }
    expect(await countChainRows(m.loser)).toBeGreaterThan(0); // elevation_requests alone

    await expireChainByRetention(m.loser);
    const sweep = await sweepOffboardingTenants();
    expect(sweep.evidenceHoldsReleased).toBe(1);
    expect(await holdRow(m.loser)).toBeUndefined();
  }, 120_000);

  it('a loser owning only un-actuated elevation requests is still held', async () => {
    const m = await seedHeldMerge();
    await getTestDb().transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx.execute(sql`DELETE FROM pam_actuation_results WHERE org_id = ${m.loser}::uuid`);
      await tx.execute(sql`DELETE FROM pam_actuations WHERE org_id = ${m.loser}::uuid`);
    });
    const reason = await writeHold({
      partnerId: m.partnerId, loserOrgId: m.loser, survivorOrgId: m.survivor, mergeEventId: m.mergeEventId,
    });
    expect(reason).toBe('pam_evidence');
  });

  it('a backup legal hold on a held shell refuses the survivor erasure before anything is erased', async () => {
    const m = await seedHeldMerge(); // A = loser, B = survivor
    const actor = await createUser({ partnerId: m.partnerId, orgId: null, email: `lh-${m.loser}@hold.test` });
    await writeHold({ partnerId: m.partnerId, loserOrgId: m.loser, survivorOrgId: m.survivor, mergeEventId: m.mergeEventId });
    // A second, older shell X held under the same survivor, with no legal hold.
    const x = await createOrganization({ partnerId: m.partnerId });
    const eventX = await markMergedShell({ partnerId: m.partnerId, loserOrgId: x.id, survivorOrgId: m.survivor });
    await insertHoldRaw({ partnerId: m.partnerId, loserOrgId: x.id, survivorOrgId: m.survivor, mergeEventId: eventX });
    await seedLegalHold(m.loser, m.orgs.L!.siteId);
    const md5 = await chainMd5(m.loser);

    const refused = await cascadeDeleteOrg(m.survivor, actor.id).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(TenantCascadeRefusalError);
    expect((refused as TenantCascadeRefusalError).code).toBe('LEGAL_HOLD_ACTIVE');

    // Nothing erased: neither shell, nor either hold, nor the survivor.
    for (const id of [m.loser, x.id]) {
      expect(await orgState(id)).toEqual({ status: 'merging', deleted: true });
      expect(await holdRow(id)).toBeDefined();
    }
    expect(await orgState(m.survivor)).toBeDefined();
    expect(await chainMd5(m.loser)).toBe(md5);
  }, 120_000);

  it('partner purge erases held shells through their survivor and leaves no hold behind', async () => {
    const m = await seedHeldMerge();
    const actor = await createUser({ partnerId: m.partnerId, orgId: null, email: `pp-${m.loser}@hold.test` });
    await writeHold({ partnerId: m.partnerId, loserOrgId: m.loser, survivorOrgId: m.survivor, mergeEventId: m.mergeEventId });
    const c = await createOrganization({ partnerId: m.partnerId });
    const eventBC = await markMergedShell({ partnerId: m.partnerId, loserOrgId: m.survivor, survivorOrgId: c.id });
    await writeHold({ partnerId: m.partnerId, loserOrgId: m.survivor, survivorOrgId: c.id, mergeEventId: eventBC });

    await cascadeDeletePartner(m.partnerId, actor.id);

    for (const id of [m.loser, m.survivor, c.id]) expect(await orgState(id)).toBeUndefined();
    expect(rowsOf(await getTestDb().execute(sql`
      SELECT 1 FROM org_evidence_holds WHERE partner_id = ${m.partnerId}::uuid`))).toHaveLength(0);
    expect(rowsOf(await getTestDb().execute(sql`
      SELECT 1 FROM partners WHERE id = ${m.partnerId}::uuid`))).toHaveLength(0);
  }, 180_000);

  it('the sweeper stamps a held shell whose stamp never landed but does not hand it to erasure', async () => {
    const m = await seedHeldMerge();
    await writeHold({ partnerId: m.partnerId, loserOrgId: m.loser, survivorOrgId: m.survivor, mergeEventId: m.mergeEventId });
    // Torn state: Phase B committed (event + hold) but deleted_at never stamped.
    await getTestDb().execute(sql`
      UPDATE organizations SET deleted_at = NULL, updated_at = now() - interval '3 hours'
       WHERE id = ${m.loser}::uuid`);
    const md5 = await chainMd5(m.loser);

    const sweep = await sweepOffboardingTenants();
    expect(sweep.mergeShellsStamped).toBe(1);
    expect(sweep.mergeUnfenced).toBe(0);
    expect(await orgState(m.loser)).toEqual({ status: 'merging', deleted: true });
    expect(await erasureJobFor(m.loser), 'a held shell was handed to erasure by the stamp path').toBeFalsy();
    expect(await chainMd5(m.loser)).toBe(md5);
    await eventually(async () => {
      const stamped = await auditsFor('org.merge.stamped_by_sweeper', m.loser);
      expect(stamped).toHaveLength(1);
      expect(String(stamped[0]!.details.note)).toContain('kept under its evidence hold');
    });
  }, 120_000);
});
