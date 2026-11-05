/**
 * A real SQL error while reading the containment policy (#10100). Postgres aborts the transaction on any
 * failed statement, so the read needs its own savepoint: without it, catching the error leaves the
 * heartbeat's org transaction unusable and nothing after it commits. CI Integration Tests only.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { closeDb, db, withDbAccessContext, withDbTransaction, type DbAccessContext } from '../../db';
import { deviceNetworkIsolations } from '../../db/schema';
import { createEpisode, type EpisodeTx } from '../../services/networkIsolation/episodeStore';
import { buildContainmentHeartbeatBlock } from '../../services/networkIsolation/reconcile';
import { createDevice, createOrganization, createPartner, createSite } from './db-utils';

vi.mock('../../services/featureConfigResolver', async (original) => ({
  ...(await original<typeof import('../../services/featureConfigResolver')>()),
  resolveContainmentPolicy: async () => {
    const { db: database } = await import('../../db');
    await database.execute(sql`select 1 / 0`);
    throw new Error('the failing statement should have thrown');
  },
}));

afterAll(() => closeDb());

describe('a policy read that fails with a SQL error', () => {
  it('keeps the held policy and leaves the transaction usable', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const device = await createDevice({ orgId: org.id, siteId: site.id });
    const context: DbAccessContext = { scope: 'organization', orgId: org.id, accessibleOrgIds: [org.id], accessiblePartnerIds: [], userId: null, currentPartnerId: partner.id };
    const held = { kind: 'cidr' as const, cidr: '192.0.2.0/24', proto: 'tcp' as const, ports: [443], scope: 'any' as const };
    const episode = await withDbAccessContext(context, () => db.transaction(async (tx) => {
      const created = await createEpisode(tx, { id: randomUUID(), deviceId: device.id, orgId: org.id, requestedByKind: 'system', reason: 'Containment test', breakGlassSecretEnc: '', expiresAt: new Date(Date.now() + 3_600_000), allowSnapshot: [held], allowSnapshotRevision: 'c1:held' });
      if (!created.ok) throw new Error(created.error);
      return created.episode;
    }));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await withDbAccessContext(context, async () => {
        // The route's own shape: the block builds in a savepoint inside the org transaction.
        const block = await withDbTransaction(() => buildContainmentHeartbeatBlock(db as unknown as EpisodeTx, { ...device, orgId: org.id, agentServerUrl: 'https://control.example.test', networkIsolationVersion: 3 }));
        expect(block.networkIsolation).toMatchObject({ generation: 1, policyRevision: 'c1:held' });
        expect(block.networkIsolation!.allow).toContainEqual(held);
        // Still usable: on an aborted transaction this statement would fail.
        const [row] = await db.select().from(deviceNetworkIsolations).where(eq(deviceNetworkIsolations.id, episode.id));
        expect(row).toMatchObject({ generation: 1, allowSnapshotRevision: 'c1:held' });
      });
      expect(error).toHaveBeenCalledWith('[isolation] policy unavailable', expect.objectContaining({ isolationId: episode.id }));
    } finally { error.mockRestore(); }
  });
});
