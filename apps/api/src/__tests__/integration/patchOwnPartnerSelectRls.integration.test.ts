/**
 * #7647 — own-partner SELECT branch on the partner-axis patch tables
 * (migration 2026-11-13-140000-patch-partner-axis-own-partner-select.sql).
 *
 * Runs as the unprivileged `breeze_app` role under vitest.integration.config.ts,
 * so RLS is enforced. Proves, against real Postgres:
 *   - an ORGANIZATION-scope context (accessiblePartnerIds = []) whose own
 *     partner is P reads P's patch_policies / patch_approvals in place;
 *   - it never reads another partner's rows, and a context with no own
 *     partner (portal shape) reads none;
 *   - writes are NOT widened: INSERT is rejected (42501), UPDATE / DELETE
 *     target zero rows;
 *   - end to end, the ring-aware evaluator behind GET /devices/:id/patches
 *     (`loadDevicePatchApprovalView`) sees a manual approval when run directly
 *     in the org context — before the branch it read zero approval rows there
 *     and reported `needs_approval`, which is why the route escaped to a
 *     second pooled connection.
 *
 * Fixtures are re-seeded per test: setup.ts TRUNCATEs between tests.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { buildDbAccessContext } from '../../middleware/auth';
import { devicePatches, devices, patchApprovals, patchPolicies, patches } from '../../db/schema';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';
import { loadDevicePatchApprovalView } from '../../services/devicePatchApprovalView';

const runDb = it.runIf(!!process.env.DATABASE_URL);

// Built with the PRODUCTION builder authMiddleware uses, so the context tracks
// whatever org scope really carries (accessiblePartnerIds [] + own partner).
// `partnerId: null` is the portal shape: no own partner in the session.
function orgCtx(orgId: string, partnerId: string | null): DbAccessContext {
  return buildDbAccessContext({ scope: 'organization', orgId, accessibleOrgIds: [orgId], partnerId, userId: null });
}

async function seed() {
  const partnerA = await createPartner();
  const partnerB = await createPartner();
  const orgA = await createOrganization({ partnerId: partnerA.id });
  const orgB = await createOrganization({ partnerId: partnerB.id });
  const siteA = await createSite({ orgId: orgA.id });

  const [patch] = await getTestDb()
    .insert(patches)
    .values({
      source: 'microsoft',
      externalId: `microsoft:${randomUUID()}`,
      title: '7647 own-partner patch',
      severity: 'important',
    })
    .returning({ id: patches.id });
  if (!patch) throw new Error('seed: no patch');

  const [device] = await getTestDb()
    .insert(devices)
    .values({
      orgId: orgA.id,
      siteId: siteA!.id,
      agentId: `agent-7647-${randomUUID()}`,
      hostname: `host-7647-${randomUUID().slice(0, 8)}`,
      osType: 'windows',
      osVersion: '11',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'online',
    })
    .returning({ id: devices.id });
  if (!device) throw new Error('seed: no device');

  await getTestDb()
    .insert(devicePatches)
    .values({ deviceId: device.id, orgId: orgA.id, patchId: patch.id, status: 'pending' });

  const { ringA, ringB } = await withSystemDbAccessContext(async () => {
    const [ringA] = await db
      .insert(patchPolicies)
      .values({ partnerId: partnerA.id, kind: 'ring', name: `ring-A-${randomUUID()}` })
      .returning({ id: patchPolicies.id });
    const [ringB] = await db
      .insert(patchPolicies)
      .values({ partnerId: partnerB.id, kind: 'ring', name: `ring-B-${randomUUID()}` })
      .returning({ id: patchPolicies.id });
    await db.insert(patchApprovals).values([
      { partnerId: partnerA.id, patchId: patch.id, status: 'approved' },
      { partnerId: partnerB.id, patchId: patch.id, status: 'approved' },
    ]);
    return { ringA: ringA!, ringB: ringB! };
  });

  return { partnerA, partnerB, orgA, orgB, patchId: patch.id, deviceId: device.id, ringA, ringB };
}

describe('patch partner-axis tables — own-partner SELECT branch (#7647)', () => {
  runDb('org-scope context reads its own partner rings and approvals, never another partner', async () => {
    const { partnerA, orgA, ringA, ringB } = await seed();

    const { rings, approvals } = await withDbAccessContext(orgCtx(orgA.id, partnerA.id), async () => ({
      rings: await db.select({ id: patchPolicies.id }).from(patchPolicies),
      approvals: await db.select({ partnerId: patchApprovals.partnerId }).from(patchApprovals),
    }));

    expect(rings.map((r) => r.id)).toEqual([ringA.id]);
    expect(rings.map((r) => r.id)).not.toContain(ringB.id);
    expect(approvals).toEqual([{ partnerId: partnerA.id }]);
  });

  runDb('a context with no own partner (portal shape) reads nothing', async () => {
    const { orgA } = await seed();

    const { rings, approvals } = await withDbAccessContext(orgCtx(orgA.id, null), async () => ({
      rings: await db.select({ id: patchPolicies.id }).from(patchPolicies),
      approvals: await db.select({ id: patchApprovals.id }).from(patchApprovals),
    }));

    expect(rings).toHaveLength(0);
    expect(approvals).toHaveLength(0);
  });

  runDb('writes are not widened: INSERT 42501, UPDATE and DELETE target zero rows', async () => {
    const { partnerA, orgA, ringA, patchId } = await seed();
    const ctx = orgCtx(orgA.id, partnerA.id);

    await expect(
      withDbAccessContext(ctx, () =>
        db.insert(patchPolicies).values({ partnerId: partnerA.id, kind: 'ring', name: `forge-${randomUUID()}` })
      )
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(
      withDbAccessContext(ctx, () =>
        db.insert(patchApprovals).values({ partnerId: partnerA.id, patchId, status: 'approved' })
      )
    ).rejects.toMatchObject({ cause: { code: '42501' } });

    const updated = await withDbAccessContext(ctx, () =>
      db.update(patchPolicies).set({ name: 'hijacked' }).where(eq(patchPolicies.id, ringA.id)).returning({ id: patchPolicies.id })
    );
    expect(updated).toHaveLength(0);
    const deletedApprovals = await withDbAccessContext(ctx, () =>
      db.delete(patchApprovals).where(eq(patchApprovals.partnerId, partnerA.id)).returning({ id: patchApprovals.id })
    );
    expect(deletedApprovals).toHaveLength(0);
    const deletedRings = await withDbAccessContext(ctx, () =>
      db.delete(patchPolicies).where(eq(patchPolicies.id, ringA.id)).returning({ id: patchPolicies.id })
    );
    expect(deletedRings).toHaveLength(0);

    // Non-vacuous: the rows are still there, unchanged.
    const [ring] = await withSystemDbAccessContext(() =>
      db.select({ name: patchPolicies.name }).from(patchPolicies).where(eq(patchPolicies.id, ringA.id))
    );
    expect(ring?.name).not.toBe('hijacked');
    const approvalsLeft = await withSystemDbAccessContext(() =>
      db.select({ id: patchApprovals.id }).from(patchApprovals).where(eq(patchApprovals.partnerId, partnerA.id))
    );
    expect(approvalsLeft).toHaveLength(1);
  });

  runDb('the ring-aware evaluator sees the manual approval in the org request context', async () => {
    const { partnerA, orgA, deviceId, patchId } = await seed();

    const view = await withDbAccessContext(orgCtx(orgA.id, partnerA.id), () =>
      loadDevicePatchApprovalView(deviceId, orgA.id)
    );

    expect(view.evaluation.available).toBe(true);
    expect(view.byPatchId.get(patchId)).toEqual({ state: 'approved', reason: 'manual', holdUntil: null });
  });
});
