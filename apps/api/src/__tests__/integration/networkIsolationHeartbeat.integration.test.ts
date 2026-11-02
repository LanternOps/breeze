/** Real-DB containment reconciliation. CI Integration Tests only (requires Postgres/Redis).
 * Guard-flip read: removing the device/org comparison accepts the foreign report in test 2;
 * removing checkOrdering accepts seq=1 in test 1; dropping tombstone lookup removes test 3's block.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb, db, withDbAccessContext } from '../../db';
import { deviceNetworkIsolations } from '../../db/schema';
import { createEpisode, type EpisodeTx } from '../../services/networkIsolation/episodeStore';
import { buildContainmentHeartbeatBlock, reconcileContainmentReport } from '../../services/networkIsolation/reconcile';
import { createDevice, createOrganization, createPartner, createSite } from './db-utils';
import { orgContext } from './topology-fixtures';
afterAll(() => closeDb());
async function fixture() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const device = await createDevice({ orgId: org.id, siteId: site.id });
  const episode = await withDbAccessContext(orgContext(org.id), () => db.transaction(async (tx) => {
    const result = await createEpisode(tx, { id: randomUUID(), deviceId: device.id, orgId: org.id, requestedByKind: 'system', reason: 'Containment test', breakGlassSecretEnc: 'unused', expiresAt: new Date(Date.now() + 3_600_000) });
    if (!result.ok) throw new Error(result.error);
    return result.episode;
  }));
  return { device: { ...device, orgId: org.id, agentServerUrl: 'https://control.example.test' }, episode, context: orgContext(org.id) };
}
const report = (id: string, journalSeq: number) => ({ isolationId: id, generation: 1, journalSeq, state: 'verified', phase: 'committed', secretAckSeq: journalSeq });
describe('containment heartbeat persistence', () => {
  it('orders reports under the episode row lock and never persists the delivery secret', async () => {
    const { device, episode, context } = await fixture();
    await withDbAccessContext(context, () => db.transaction(async (tx) => {
      await reconcileContainmentReport(tx, device, { ...report(episode.id, 2), breakGlassSecret: 'NEVER-PERSIST' }, new Date());
      await reconcileContainmentReport(tx, device, { ...report(episode.id, 1), state: 'released', phase: 'released' }, new Date());
      const [row] = await tx.select().from(deviceNetworkIsolations).where(eq(deviceNetworkIsolations.id, episode.id));
      expect(row).toMatchObject({ state: 'verified', lastJournalSeq: 2, breakGlassAckSeq: 2 });
      expect(JSON.stringify(row!.lastAgentReport)).not.toContain('NEVER-PERSIST');
    }));
  });
  it('refuses another device report even inside the same tenant', async () => {
    const { device, episode, context } = await fixture();
    await withDbAccessContext(context, () => db.transaction(async (tx) => {
      await reconcileContainmentReport(tx, { ...device, id: randomUUID() }, report(episode.id, 2), new Date());
      const [row] = await tx.select().from(deviceNetworkIsolations).where(eq(deviceNetworkIsolations.id, episode.id));
      expect(row!.state).toBe('requested');
    }));
  });
  it('retains resolved tombstones until the matching absence report', async () => {
    const { device, episode, context } = await fixture();
    await withDbAccessContext(context, () => db.transaction(async (tx: EpisodeTx) => {
      await tx.update(deviceNetworkIsolations).set({ state: 'failed', desiredState: 'released', failureCode: 'not_delivered', generation: 2 }).where(eq(deviceNetworkIsolations.id, episode.id));
      expect((await buildContainmentHeartbeatBlock(tx, device)).networkIsolation).toMatchObject({ generation: 2, desired: 'released', allow: [] });
      await reconcileContainmentReport(tx, device, { isolationId: null, phase: 'none' }, new Date());
      expect((await buildContainmentHeartbeatBlock(tx, device)).networkIsolation).toBeNull();
    }));
  });
});
