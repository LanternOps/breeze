/**
 * Containment policy on a real database (#10100): a partner-wide policy reaches a held episode through
 * the heartbeat's own org context, under RLS, as a new generation. CI Integration Tests only.
 *
 * The context here is the heartbeat's shape: org-scoped, no partner-axis access, and `currentPartnerId`
 * carrying the agent's partner. Without that GUC the partner-wide row is invisible, which the blind case
 * pins, so a reintroduced system-context escape fails it.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { containmentDesiredBlockSchema } from '@breeze/shared';
import { closeDb, db, withDbAccessContext, withDbTransaction, type DbAccessContext } from '../../db';
import {
  configPolicyAssignments, configPolicyFeatureLinks, configurationPolicies, deviceNetworkIsolations, incidents,
} from '../../db/schema';
import { createEpisode, type EpisodeTx } from '../../services/networkIsolation/episodeStore';
import { isolationPolicyPending } from '../../services/networkIsolation/policy';
import { buildContainmentHeartbeatBlock, reconcileContainmentReport } from '../../services/networkIsolation/reconcile';
import { createDevice, createOrganization, createPartner, createSite } from './db-utils';

afterAll(() => closeDb());

const SYSTEM: DbAccessContext = { scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null };
const EXTRA = { cidr: '192.0.2.0/24', proto: 'tcp', ports: [443], label: 'EDR console' };
const WIRE = { kind: 'cidr', cidr: '192.0.2.0/24', proto: 'tcp', ports: [443], scope: 'any' };

async function fixture() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const device = await createDevice({ orgId: org.id, siteId: site.id });
  const context: DbAccessContext = { scope: 'organization', orgId: org.id, accessibleOrgIds: [org.id], accessiblePartnerIds: [], userId: null, currentPartnerId: partner.id };
  const incidentId = randomUUID();
  const episode = await withDbAccessContext(context, () => db.transaction(async (tx) => {
    await tx.insert(incidents).values({ id: incidentId, orgId: org.id, title: 'Containment test', classification: 'manual_containment', severity: 'p2', affectedDevices: [device.id], detectedAt: new Date() });
    const created = await createEpisode(tx, { id: randomUUID(), deviceId: device.id, orgId: org.id, incidentId, requestedByKind: 'system', reason: 'Containment test', breakGlassSecretEnc: '', expiresAt: new Date(Date.now() + 3_600_000), allowSnapshot: [{ kind: 'host', host: 'control.example.test', proto: 'tcp', ports: [443], scope: 'breeze' }], allowSnapshotRevision: null });
    if (!created.ok) throw new Error(created.error);
    return created.episode;
  }));
  return {
    partner, org, episode, incidentId, context,
    level3: { ...device, orgId: org.id, agentServerUrl: 'https://control.example.test', networkIsolationVersion: 3 },
  };
}

async function seedPartnerPolicy(partnerId: string, extraAllow: unknown[]) {
  return withDbAccessContext(SYSTEM, async () => {
    const [policy] = await db.insert(configurationPolicies).values({ orgId: null, partnerId, name: `containment ${randomUUID()}`, status: 'active' }).returning();
    await db.insert(configPolicyFeatureLinks).values({ configPolicyId: policy!.id, featureType: 'containment', inlineSettings: { version: 1, extraAllow } });
    await db.insert(configPolicyAssignments).values({ configPolicyId: policy!.id, level: 'partner', targetId: partnerId, priority: 0 });
    return policy!.id;
  });
}

/** A beat's block build, in its own savepoint as the heartbeat route runs it. */
const beat = (context: DbAccessContext, device: Parameters<typeof buildContainmentHeartbeatBlock>[1]) => withDbAccessContext(context, () =>
  withDbTransaction(() => buildContainmentHeartbeatBlock(db as unknown as EpisodeTx, device)));
const readRow = (context: DbAccessContext, id: string) => withDbAccessContext(context, async () => {
  const [row] = await db.select().from(deviceNetworkIsolations).where(eq(deviceNetworkIsolations.id, id));
  return row!;
});
const timelineTypes = (context: DbAccessContext, id: string) => withDbAccessContext(context, async () => {
  const [row] = await db.select({ timeline: incidents.timeline }).from(incidents).where(eq(incidents.id, id));
  return (row!.timeline as { type: string }[]).map((entry) => entry.type);
});

describe('containment policy on a held episode', () => {
  it('a partner-wide policy arrives as a new generation, with the snapshot, and only once', async () => {
    const { partner, episode, context, level3, incidentId } = await fixture();
    await seedPartnerPolicy(partner.id, [EXTRA]);

    const first = await beat(context, level3);
    expect(containmentDesiredBlockSchema.safeParse(first).success).toBe(true);
    expect(first.networkIsolation).toMatchObject({ generation: 2, policyRevision: expect.stringMatching(/^c1:[0-9a-f]{32}$/) });
    expect(first.networkIsolation!.allow).toContainEqual(WIRE);

    const row = await readRow(context, episode.id);
    expect(row).toMatchObject({ generation: 2, allowSnapshotRevision: (first.networkIsolation as { policyRevision: string }).policyRevision });
    expect(row.allowSnapshot).toContainEqual(WIRE);
    expect(isolationPolicyPending(row)).toBe(true);

    const second = await beat(context, level3);
    expect(second.networkIsolation).toMatchObject({ generation: 2 });
    expect(await timelineTypes(context, incidentId)).toEqual(['isolation_policy_changed']);
  });

  it('two beats racing over one change take one generation and one timeline entry', async () => {
    const { partner, episode, context, level3, incidentId } = await fixture();
    await seedPartnerPolicy(partner.id, [EXTRA]);
    const blocks = await Promise.all([beat(context, level3), beat(context, level3)]);
    for (const block of blocks) expect(block.networkIsolation).toMatchObject({ generation: 2 });
    expect((await readRow(context, episode.id)).generation).toBe(2);
    expect(await timelineTypes(context, incidentId)).toEqual(['isolation_policy_changed']);
  });

  it('a context blind to the partner sees no policy and takes no generation', async () => {
    const { partner, episode, context, level3 } = await fixture();
    await seedPartnerPolicy(partner.id, [EXTRA]);
    const block = await beat({ ...context, currentPartnerId: null }, level3);
    expect(block.networkIsolation).toMatchObject({ generation: 1 });
    expect(block.networkIsolation!.allow.some((entry) => entry.scope === 'any')).toBe(false);
    expect((await readRow(context, episode.id)).generation).toBe(1);
  });

  it('below level 3 the policy is not sent and the generation does not move', async () => {
    const { partner, episode, context, level3 } = await fixture();
    await seedPartnerPolicy(partner.id, [EXTRA]);
    const block = await beat(context, { ...level3, networkIsolationVersion: 1 });
    expect(block.networkIsolation!.allow.some((entry) => entry.scope === 'any')).toBe(false);
    expect(block.networkIsolation).not.toHaveProperty('policyRevision');
    expect((await readRow(context, episode.id)).generation).toBe(1);
  });

  it('a rolled-back beat loses the generation, the snapshot and the timeline entry together', async () => {
    const { partner, episode, context, level3, incidentId } = await fixture();
    await seedPartnerPolicy(partner.id, [EXTRA]);
    await expect(withDbAccessContext(context, () => withDbTransaction(async () => {
      await buildContainmentHeartbeatBlock(db as unknown as EpisodeTx, level3);
      const [inside] = await db.select().from(deviceNetworkIsolations).where(eq(deviceNetworkIsolations.id, episode.id));
      expect(inside).toMatchObject({ generation: 2 });
      throw new Error('fail the savepoint');
    }))).rejects.toThrow('fail the savepoint');
    const row = await readRow(context, episode.id);
    expect(row).toMatchObject({ generation: 1, allowSnapshotRevision: null });
    expect(row.allowSnapshot.some((entry) => entry.scope === 'any')).toBe(false);
    expect(await timelineTypes(context, incidentId)).toEqual([]);
  });

  it('removing the policy narrows under a new generation, and is done only when the agent commits it', async () => {
    const { partner, episode, context, level3, incidentId } = await fixture();
    const policyId = await seedPartnerPolicy(partner.id, [EXTRA]);
    const applied = await beat(context, level3);
    const revision = (applied.networkIsolation as { policyRevision: string }).policyRevision;
    const report = (generation: number, journalSeq: number, events: unknown[], ruleDigest: string) => ({ isolationId: episode.id, generation, journalSeq, state: 'verified', phase: 'committed', ruleDigest, events });
    const at = new Date();
    const reconcile = (raw: unknown) => withDbAccessContext(context, () => withDbTransaction(() => reconcileContainmentReport(db as unknown as EpisodeTx, level3, raw, at)));
    const event = (seq: number, type: string, generation: number, detail?: string) => ({ seq, at: at.toISOString(), type, isolationId: episode.id, generation, ...(detail ? { detail } : {}) });

    await reconcile(report(2, 3, [event(3, 'policy_applied', 2, revision)], 'with-permit'));
    expect(isolationPolicyPending(await readRow(context, episode.id))).toBe(false);

    await withDbAccessContext(SYSTEM, () => db.update(configurationPolicies).set({ status: 'inactive' }).where(eq(configurationPolicies.id, policyId)));
    const narrowed = await beat(context, level3);
    expect(narrowed.networkIsolation).toMatchObject({ generation: 3 });
    expect(narrowed.networkIsolation).not.toHaveProperty('policyRevision');

    // A failed refresh: the rules stay, and the agent still says verified at the new generation.
    const reverted = event(4, 'refresh_reverted', 3, 'apply_error');
    await reconcile(report(3, 4, [event(3, 'policy_applied', 2, revision), reverted], 'with-permit'));
    await reconcile(report(3, 4, [event(3, 'policy_applied', 2, revision), reverted], 'with-permit'));
    expect(await readRow(context, episode.id)).toMatchObject({ state: 'verified', appliedPolicyRevision: revision, policyEventSeq: 4 });
    expect(isolationPolicyPending(await readRow(context, episode.id))).toBe(true);

    await reconcile(report(3, 6, [event(3, 'policy_applied', 2, revision), reverted, event(5, 'refreshed', 3), event(6, 'policy_removed', 3, revision)], 'narrowed'));
    expect(await readRow(context, episode.id)).toMatchObject({ appliedPolicyRevision: null, policyEventSeq: 6 });
    expect(isolationPolicyPending(await readRow(context, episode.id))).toBe(false);

    expect(await timelineTypes(context, incidentId)).toEqual([
      'isolation_policy_changed', 'policy_applied', 'isolation_policy_changed', 'policy_refresh_reverted', 'policy_removed',
    ]);
  });
});
