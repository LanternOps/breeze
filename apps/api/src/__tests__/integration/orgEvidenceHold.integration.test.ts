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
 *   5.1 the hold is written; Phase C hands the shell to erasure, which erases
 *       everything but the organizations row and the evidence it retains
 *       (W6-pre #8746: the hold scopes erasure instead of refusing it); the
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
import {
  EVIDENCE_HOLD_ANCHOR_TABLES,
  EVIDENCE_HOLD_CHAIN_TABLES,
  EVIDENCE_HOLD_RETAINED_TABLES,
  EVIDENCE_HOLD_SCOPED_ERASURE_KEY,
  writeEvidenceHold,
} from '../../services/orgEvidenceHold';
import * as orgMergeModule from '../../services/orgMerge';
import { runMergePhaseC } from '../../jobs/orgMerge';
import { sweepOffboardingTenants } from '../../services/tenantOffboarding';
import { getTenantErasureQueue } from '../../jobs/tenantErasure';
import {
  cascadeDeleteOrg,
  cascadeDeletePartner,
  getOrgCascadeDeleteOrder,
  TenantCascadeRefusalError,
} from '../../services/tenantCascade';

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
    // W6-pre (#8746): the held shell IS handed to erasure; the erasure itself
    // keeps the evidence (see the scoped-erasure tests below).
    expect(await erasureJobFor(m.loser), 'Phase C did not hand the held shell to erasure').toBeTruthy();
    await eventually(async () => {
      const deferred = await auditsFor('tenant.erasure.deferred_evidence_hold', m.loser);
      expect(deferred).toHaveLength(1);
      expect(deferred[0]!.org_id).toBeNull();
      expect(deferred[0]!.details).toMatchObject({ survivorOrgId: m.survivor, stage: 'merge_phase_c' });
      const enqueued = await auditsFor('org.merge.erasure_enqueued', m.loser);
      expect(enqueued).toHaveLength(1);
      expect(enqueued[0]!.details).toMatchObject({ evidenceHoldScoped: true });
    });

    // A direct erasure (any enqueue path ends here) erases around the evidence.
    await repointLoserSite(m);
    const stats = await cascadeDeleteOrg(m.loser, actor.id);
    expect(stats.evidenceHoldScoped).toBe(true);

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

    // Erasing either held shell directly is scoped: B's erasure must not
    // release or erase A (B is A's survivor), and neither erases any chain.
    // After A -> B -> C, A's former site lives in C.
    await repointLoserSite(m, c.id);
    await expect(cascadeDeleteOrg(m.survivor, actor.id)).resolves.toMatchObject({ evidenceHoldScoped: true });
    await expect(cascadeDeleteOrg(m.loser, actor.id)).resolves.toMatchObject({ evidenceHoldScoped: true });
    expect(await holdRow(m.loser)).toMatchObject({ survivor_org_id: m.survivor });
    expect(await holdRow(m.survivor)).toMatchObject({ survivor_org_id: c.id });

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

    // Still held while the chain has rows (case 1 may hand the shell to its
    // scoped erasure, which keeps the chain; the hold is what must stand).
    const md5 = await chainMd5(m.loser);
    await sweepOffboardingTenants();
    expect(await holdRow(m.loser)).toBeDefined();
    expect(await chainMd5(m.loser)).toBe(md5);

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
    expect(await holdRow(m.loser)).toBeDefined();
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

  it('the sweeper stamps a held shell whose stamp never landed and hands it to (scoped) erasure', async () => {
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
    expect(await erasureJobFor(m.loser), 'the stamp path did not hand the held shell to erasure').toBeTruthy();
    expect(await chainMd5(m.loser)).toBe(md5);
    await eventually(async () => {
      const stamped = await auditsFor('org.merge.stamped_by_sweeper', m.loser);
      expect(stamped).toHaveLength(1);
      expect(String(stamped[0]!.details.note)).toContain('evidence hold');
      expect(stamped[0]!.details).toMatchObject({ evidenceHold: { survivorOrgId: m.survivor } });
    });
  }, 120_000);
});

// ---------------------------------------------------------------------------
// W6-pre (#8746): the hold scopes erasure to the evidence it retains.
// ---------------------------------------------------------------------------

/** What a real Phase B leaves under L: its site moved to the survivor (sites are REPOINT). */
async function repointLoserSite(m: Awaited<ReturnType<typeof seedHeldMerge>>, to: string = m.survivor): Promise<void> {
  await getTestDb().transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`);
    await tx.execute(sql`UPDATE sites SET org_id = ${to}::uuid WHERE id = ${m.orgs.L!.siteId}::uuid`);
  });
}

async function retainedCounts(orgId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of EVIDENCE_HOLD_RETAINED_TABLES) {
    const [row] = rowsOf<{ n: number }>(await getTestDb().execute(sql`
      SELECT count(*)::int AS n FROM ${sql.identifier(t)} WHERE org_id = ${orgId}::uuid`));
    out[t] = Number(row?.n ?? 0);
  }
  return out;
}

/** Every org-cascade table (minus the retained set and organizations) that still has a row for `orgId`. */
async function nonRetainedLeftovers(orgId: string): Promise<Record<string, number>> {
  const retained = new Set<string>([...EVIDENCE_HOLD_RETAINED_TABLES, 'organizations']);
  const cols = rowsOf<{ table_name: string }>(await getTestDb().execute(sql`
    SELECT table_name::text FROM information_schema.columns
     WHERE table_schema = 'public' AND column_name = 'org_id'`));
  const hasOrgId = new Set(cols.map((r) => r.table_name));
  const leftovers: Record<string, number> = {};
  for (const t of getOrgCascadeDeleteOrder()) {
    if (retained.has(t) || !hasOrgId.has(t)) continue;
    const [row] = rowsOf<{ n: number }>(await getTestDb().execute(sql`
      SELECT count(*)::int AS n FROM ${sql.identifier(t)} WHERE org_id = ${orgId}::uuid`));
    if (Number(row?.n ?? 0) > 0) leftovers[t] = Number(row!.n);
  }
  return leftovers;
}

async function scopedMarker(orgId: string): Promise<unknown> {
  const [row] = rowsOf<{ marker: unknown }>(await getTestDb().execute(sql`
    SELECT settings -> ${EVIDENCE_HOLD_SCOPED_ERASURE_KEY}::text AS marker FROM organizations WHERE id = ${orgId}::uuid`));
  return row?.marker ?? null;
}

describe('W6-pre (#8746): an evidence hold scopes erasure to the retained evidence', () => {
  it('erasing a held shell removes every non-retained row and keeps only the organizations row and the evidence', async () => {
    const m = await seedHeldMerge();
    await repointLoserSite(m);
    const actor = await createUser({ partnerId: m.partnerId, orgId: null, email: `sc-${m.loser}@hold.test` });
    await writeHold({ partnerId: m.partnerId, loserOrgId: m.loser, survivorOrgId: m.survivor, mergeEventId: m.mergeEventId });
    // Non-evidence data a held shell keeps today: an audit row (the
    // audit-admin erasure path). Plus an elevation_audit row on the held
    // request, which is evidence and must survive.
    await getTestDb().execute(sql`
      INSERT INTO audit_logs (org_id, actor_type, actor_id, action, resource_type, result)
      VALUES (${m.loser}::uuid, 'system', gen_random_uuid(), 'fixture.held_shell_row', 'organization', 'success')`);
    await getTestDb().execute(sql`
      INSERT INTO elevation_audit (org_id, elevation_request_id, event_type, actor, details, occurred_at)
      VALUES (${m.loser}::uuid, ${m.epoch1.requestId}::uuid, 'requested', 'system', '{}'::jsonb, now())`);
    expect(Object.keys(await nonRetainedLeftovers(m.loser))).toContain('audit_logs');
    const md5Before = await chainMd5(m.loser);
    const retainedBefore = await retainedCounts(m.loser);
    expect(retainedBefore.device_ownership_epochs).toBeGreaterThan(0);
    expect(retainedBefore.device_ownership_epoch_closures).toBeGreaterThan(0);

    const stats = await cascadeDeleteOrg(m.loser, actor.id);

    expect(stats.evidenceHoldScoped).toBe(true);
    expect(await nonRetainedLeftovers(m.loser)).toEqual({});
    expect(await chainMd5(m.loser)).toBe(md5Before);
    expect(await retainedCounts(m.loser)).toEqual(retainedBefore);
    expect(await orgState(m.loser)).toEqual({ status: 'merging', deleted: true });
    expect(await holdRow(m.loser)).toBeDefined();
    expect(await scopedMarker(m.loser), 'scoped-erasure marker not stamped').toBeTruthy();
    await eventually(async () => {
      const completed = await auditsFor('tenant.erasure.completed', m.loser);
      expect(completed).toHaveLength(1);
      expect(completed[0]!.details).toMatchObject({
        evidenceHoldScoped: true,
        retainedTables: [...EVIDENCE_HOLD_RETAINED_TABLES, 'organizations'],
        survivorOrgId: m.survivor,
      });
    });

    // Idempotent: a second scoped run deletes nothing and still retains.
    const again = await cascadeDeleteOrg(m.loser, actor.id);
    expect(again.totalRowsDeleted).toBe(0);
    expect(await chainMd5(m.loser)).toBe(md5Before);
  }, 180_000);

  it('a non-held org is erased exactly as before (organizations row and chain included)', async () => {
    const seeded = await seedMovedDeviceWithHistory({ path: ['L', 'S'] });
    const actor = await createUser({ partnerId: seeded.partnerId, orgId: null, email: `nh-${seeded.orgs.L!.id}@hold.test` });
    await getTestDb().transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx.execute(sql`UPDATE sites SET org_id = ${seeded.orgs.S!.id}::uuid WHERE id = ${seeded.orgs.L!.siteId}::uuid`);
    });
    const stats = await cascadeDeleteOrg(seeded.orgs.L!.id, actor.id);
    expect(stats.evidenceHoldScoped).toBeUndefined();
    expect(await orgState(seeded.orgs.L!.id)).toBeUndefined();
    expect(await countChainRows(seeded.orgs.L!.id)).toBe(0);
  }, 120_000);

  it('the sweeper re-enqueues a held shell whose scoped erasure never ran, and stops once it has', async () => {
    const m = await seedHeldMerge();
    await repointLoserSite(m);
    const actor = await createUser({ partnerId: m.partnerId, orgId: null, email: `sw-${m.loser}@hold.test` });
    await writeHold({ partnerId: m.partnerId, loserOrgId: m.loser, survivorOrgId: m.survivor, mergeEventId: m.mergeEventId });

    // Phase C never ran: case 1 must hand the held shell to erasure.
    const first = await sweepOffboardingTenants();
    expect(first.failures).toBe(0);
    const job = await erasureJobFor(m.loser);
    expect(job, 'case 1 skipped a held shell whose non-evidence data was never erased').toBeTruthy();
    await job!.remove();

    // Once the scoped erasure has completed, case 1 leaves the shell alone.
    await cascadeDeleteOrg(m.loser, actor.id);
    await getTestDb().execute(sql`
      UPDATE organizations SET updated_at = now() - interval '3 hours' WHERE id = ${m.loser}::uuid`);
    const second = await sweepOffboardingTenants();
    expect(second.failures).toBe(0);
    expect(await erasureJobFor(m.loser), 'case 1 re-enqueued an already scoped-erased held shell').toBeFalsy();
  }, 180_000);

  it('the retained set is exactly the lineage-readable set, and the release predicate is its evidence subset', async () => {
    const rows = rowsOf<{ tablename: string }>(await getTestDb().execute(sql`
      SELECT tablename::text AS tablename FROM pg_policies
       WHERE schemaname = 'public' AND policyname = 'breeze_merged_lineage_select'`));
    expect([...EVIDENCE_HOLD_RETAINED_TABLES].sort()).toEqual(rows.map((r) => r.tablename).sort());
    expect([...EVIDENCE_HOLD_RETAINED_TABLES].sort()).toEqual(
      [...EVIDENCE_HOLD_CHAIN_TABLES, ...EVIDENCE_HOLD_ANCHOR_TABLES].sort(),
    );
  });

  it('writeEvidenceHold is idempotent: a Phase B retry returns the same reason and writes no second row', async () => {
    const m = await seedHeldMerge();
    const input = { partnerId: m.partnerId, loserOrgId: m.loser, survivorOrgId: m.survivor, mergeEventId: m.mergeEventId };
    expect(await writeHold(input)).toBe('pam_evidence');
    expect(await writeHold(input)).toBe('pam_evidence');
    expect(rowsOf(await getTestDb().execute(sql`
      SELECT 1 FROM org_evidence_holds WHERE loser_org_id = ${m.loser}::uuid`))).toHaveLength(1);
  });
});

describe('W6-pre (#8746) review follow-ups', () => {
  it('a backup legal hold on a held shell refuses its scoped erasure before anything is erased or stamped', async () => {
    const m = await seedHeldMerge();
    const actor = await createUser({ partnerId: m.partnerId, orgId: null, email: `slh-${m.loser}@hold.test` });
    await writeHold({ partnerId: m.partnerId, loserOrgId: m.loser, survivorOrgId: m.survivor, mergeEventId: m.mergeEventId });
    await seedLegalHold(m.loser, m.orgs.L!.siteId);
    const leftoversBefore = await nonRetainedLeftovers(m.loser);
    expect(Object.keys(leftoversBefore).length).toBeGreaterThan(0);
    const md5 = await chainMd5(m.loser);

    const refused = await cascadeDeleteOrg(m.loser, actor.id).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(TenantCascadeRefusalError);
    expect((refused as TenantCascadeRefusalError).code).toBe('LEGAL_HOLD_ACTIVE');
    expect(await nonRetainedLeftovers(m.loser)).toEqual(leftoversBefore);
    expect(await chainMd5(m.loser)).toBe(md5);
    expect(await scopedMarker(m.loser)).toBeNull();
    expect(await auditsFor('tenant.erasure.completed', m.loser)).toHaveLength(0);
  }, 120_000);

  it('a scoped-erased shell is still erased in full (evidence, epochs, row, hold) by its survivor erasure', async () => {
    const m = await seedHeldMerge();
    await repointLoserSite(m);
    const actor = await createUser({ partnerId: m.partnerId, orgId: null, email: `sf-${m.loser}@hold.test` });
    await writeHold({ partnerId: m.partnerId, loserOrgId: m.loser, survivorOrgId: m.survivor, mergeEventId: m.mergeEventId });
    await cascadeDeleteOrg(m.loser, actor.id);
    expect(await scopedMarker(m.loser)).toBeTruthy();

    await cascadeDeleteOrg(m.survivor, actor.id);

    expect(await orgState(m.loser)).toBeUndefined();
    expect(await holdRow(m.loser)).toBeUndefined();
    expect(Object.values(await retainedCounts(m.loser)).every((n) => n === 0)).toBe(true);
  }, 180_000);

  it('a retention-released, already scoped-erased shell is picked up for full erasure despite its stamp', async () => {
    const m = await seedHeldMerge();
    await repointLoserSite(m);
    const actor = await createUser({ partnerId: m.partnerId, orgId: null, email: `rr-${m.loser}@hold.test` });
    await writeHold({ partnerId: m.partnerId, loserOrgId: m.loser, survivorOrgId: m.survivor, mergeEventId: m.mergeEventId });
    await cascadeDeleteOrg(m.loser, actor.id);
    await expireChainByRetention(m.loser);
    await getTestDb().execute(sql`
      UPDATE organizations SET updated_at = now() - interval '3 hours' WHERE id = ${m.loser}::uuid`);
    await (await erasureJobFor(m.loser))?.remove();

    const sweep = await sweepOffboardingTenants();
    expect(sweep.evidenceHoldsReleased).toBe(1);
    expect(await holdRow(m.loser)).toBeUndefined();
    expect(await erasureJobFor(m.loser), 'released shell not handed to full erasure').toBeTruthy();

    // The handed-off erasure is now a full one.
    const stats = await cascadeDeleteOrg(m.loser, actor.id);
    expect(stats.evidenceHoldScoped).toBeUndefined();
    expect(await orgState(m.loser)).toBeUndefined();
  }, 180_000);

  it('a Phase B retry after the chain has gone still reports the standing hold; a different merge event is refused', async () => {
    const m = await seedHeldMerge();
    const input = { partnerId: m.partnerId, loserOrgId: m.loser, survivorOrgId: m.survivor, mergeEventId: m.mergeEventId };
    expect(await writeHold(input)).toBe('pam_evidence');
    await expireChainByRetention(m.loser);
    // The INSERT's WHERE is now false; the stored reason must come back, not null.
    expect(await writeHold(input)).toBe('pam_evidence');

    const otherEvent = await markMergedShell({ partnerId: m.partnerId, loserOrgId: m.loser, survivorOrgId: m.survivor });
    await expect(writeHold({ ...input, mergeEventId: otherEvent })).rejects.toThrow(/already held/);
    expect(await holdRow(m.loser)).toMatchObject({ merge_event_id: m.mergeEventId });
  });
});
